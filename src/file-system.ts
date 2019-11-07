const fs = require('fs');
const path = require('path');
const util = require('util');
import _ from 'lodash';

// file system

// given that jenkins is using node 8 we can't uses promises directly
const mkdir = util.promisify(fs.mkdir);
const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);
const access = util.promisify(fs.access);

const INVALID_FILE_CHARS_REGEX = /[\(\)\[\}\]/\\?%*:|"<>,\. =']/g;

export const removeInvalidChars = (path: string) =>
  path.replace(INVALID_FILE_CHARS_REGEX, '');

export const ensureDir = async (dirPath: string) => {
  try {
    await mkdir(dirPath);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
};

export const listJSONFiles = async (dirPath: string): Promise<string[]> => {
  const fileNames: string[] = await readdir(dirPath);
  return fileNames
    .map(name => name.split('.'))
    .filter(parts => _.last(parts) === 'json')
    .map(parts => _.first(parts) || '');
};

export const deleteJSONFile = async (filePath: string): Promise<void> => {
  await unlink(path.join(filePath));
};

export const readJSONFile = async <T>(filePath: string): Promise<T> => {
  return JSON.parse(await readFile(filePath, 'utf8'));
};

export const writeJSONFile = async <T>(filePath: string, data: T): Promise<void> => {
  writeFile(filePath, JSON.stringify(data, null, '  '), 'utf8');
};
