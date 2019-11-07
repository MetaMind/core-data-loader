const os = require('os');
const path = require('path');
import _ from 'lodash';
import jsforce from 'jsforce';
import * as fs from './file-system';
import { replaceObjectValues } from './replace-object-values';

// types

interface Relation {
  name: string;
  parentSObject: string;
  childSObject: string;
  childField: string;
}

export interface DataLoaderOptions {
  user: string;
  password: string;
  loginUrl: string;
  version: string;
  sobjectRecordsPath: string;
  sobjectTemporalIdsPath?: string;
  toolingSObjects?: string[];
  callOptions?: Dictionary<string>;
}

export interface DataLoader {
  loadData(): Promise<Dictionary<string>>;
  deleteLoadedData(): Promise<void>;
}

// consts

const SOQL_REGEX = /SELECT\s+(.*?)\s+FROM\s+(.*?)\s+WHERE\s+(.*?)($|\s+ORDER BY\s+)/i;


// the real deal

export const getDataLoader = async ({
  user,
  password,
  loginUrl,
  version,
  sobjectRecordsPath,
  sobjectTemporalIdsPath,
  toolingSObjects,
  callOptions,
}: DataLoaderOptions): Promise<DataLoader> => {
  const logLevel = process.env['LOG_LEVEL'] || 'DEBUG';
  const options = { loginUrl, version, callOptions, logLevel };
  const connection = new jsforce.Connection(options);
  const sobjectIdsPath =
    sobjectTemporalIdsPath || path.join(os.tmpdir(), 'sf-data-loader-ids');
  
  console.debug(`saving generated ids under '${sobjectIdsPath}'`);

  await Promise.all([
    connection.login(user, password),
    fs.ensureDir(sobjectRecordsPath),
    fs.ensureDir(sobjectIdsPath)
  ]);

  // wrapper to get the correct connection (tooling/normal) for sobjects
  const $ = <T>(sobject: string): jsforce.SObject<T> => {
    const baseConn = _.includes(toolingSObjects, sobject)
      ? connection.tooling
      : connection;
    return baseConn.sobject(sobject);
  };

  let sobjects = await fs.listJSONFiles(sobjectRecordsPath);
  // we want to load all json files with data about salesforce objects 
  // but ignore any json configuration file (those starting with '__')
  sobjects = sobjects.filter(sobject => !sobject.startsWith('__'));

  const recordss = await Promise.all(
    sobjects.map(o =>
      fs.readJSONFile<object[]>(
        path.join(sobjectRecordsPath, o + '.json')
      )
    )
  );
  const sobject2records = _.zipObject(sobjects, recordss);

  const parent2childObjects: Dictionary<string[]> = {};
  sobjects.forEach(parentSObject => {
    parent2childObjects[parentSObject] = sobjects
      .filter(childSObject => parentSObject !== childSObject)
      .filter(childSObject => 
        sobject2records[parentSObject].some(parentRecords => 
          JSON.stringify(sobject2records[childSObject]).indexOf(
            `"${parentRecords['id']}"`
          ) >= 0
        )
      );
  });

  const child2parentSObjects: Dictionary<string[]> = {};
  sobjects.forEach(childSObject => {
    child2parentSObjects[childSObject] = sobjects.filter(parentSObject =>
      parent2childObjects[parentSObject].indexOf(childSObject) >= 0
    );
  });

  // return confirming the interface
  return {
    async loadData(): Promise<Dictionary<string>> {
      const old2newId = {};
      const loadSObjectData = _.memoize(async (sobject: string) => {
        console.debug('creating', 'started', sobject);
        // load all the parent because we need their ids
        for (const parentSObject of child2parentSObjects[sobject]) {
          await loadSObjectData(parentSObject);
        }

        const oldRecords = sobject2records[sobject];

        const updateFieldValues = async (
          record: Object
        ): Promise<any> => {
          await Promise.all(
            Object.keys(record).map(async field => {
              record[field] = await getFieldValue(field, record[field]);
            })
          );
          return record;
        }
        

        // we use this function to get updated value for old value
        const getFieldValue = async (
          field: string,
          value: any
        ): Promise<any> => {
          if (_.isObject(value)) {
            return updateFieldValues(value)
          }
          if (!_.isString(value)) {
            return value;
          }
          // try to get the value from a query
          const matches = value.match(SOQL_REGEX);
          if (matches && matches.length > 3) {
            const soqlSelect = matches[1];
            const soqlFrom = matches[2];
            const soqlWhere = matches[3];
            const data = await $(soqlFrom)
              .find(soqlWhere, soqlSelect)
              .limit(1);
            const record = _.first(data);
            if (!record) {
              throw new Error(`Didn't find any results for query "${value}"`);
            }
            return record.Id;
          }
          // try to get the value from the parent
          // const rel = field2relation[`${sobject}.${field}`];
          if (old2newId[value]) {
            return old2newId[value];
          }
          return value;
        };

        // we map each row field value to a potential new updated value
        await Promise.all(oldRecords.map(updateFieldValues));

        // we need to remove 'id' from the records before creating them
        // but we need to keep it in case we need an update value
        // for a child record
        const oldRecordsIds = oldRecords.map(r => r['id']);
        oldRecords.forEach(r => { delete r['id']; });

        console.debug('creating', 'before creating', sobject, oldRecords);

        const newRecords: object[] = (
          await $(sobject).create(oldRecords)
        ) as any;
        if (newRecords.some(res => !res['success'])) {
          throw new Error(
            'We got an error trying to create records for ' + sobject
          );
        }

        // save the ids for the generated tests
        const newRecordsIds = newRecords.map(r => r['id']);
        await fs.writeJSONFile(
          path.join(sobjectIdsPath, sobject + '.json'),
          newRecordsIds
        );
        _.merge(old2newId, _.zipObject(oldRecordsIds, newRecordsIds));
        console.debug('creating', 'done', sobject, newRecordsIds);
      });

      for (const o of sobjects) {
        await loadSObjectData(o);
      }

      return old2newId;
    },

    async deleteLoadedData(): Promise<void> {
      const deleteLoadedSObjectData = _.memoize(async (sobject: string) => {
        console.debug('deleting', 'started', sobject);
        const sobjectIdsFile = path.join(
          sobjectIdsPath,
          sobject + '.json'
        ); 

        for (const childSObject of parent2childObjects[sobject]) {
          await deleteLoadedSObjectData(childSObject);
        }

        // get the sobject ids to be deleted
        let ids: string[] = []
        try {
          ids = await fs.readJSONFile<string[]>(sobjectIdsFile);
        }
        catch(err) {
          console.debug('deleting', 'skipped', sobject);
          return;
        }

        // delete on salesforce
        const recs: { Id: string }[] = await $(sobject).find({ Id: ids }, { Id: 1 });
        const ress = await $(sobject).destroy(recs.map(r => r.Id));
        if (ress.some(res => !res.success)) {
          throw new Error(
            `We got an error trying to delete records for ${sobject}: ${JSON.stringify(
              ress
            )}`
          );
        }

        // delete the file with the ids
        console.debug('deleting', 'done', sobject, ids);
      });

      for (const sobject of sobjects) {
        await deleteLoadedSObjectData(sobject);
      }
    }
  };
};
