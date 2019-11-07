import main from './main'

test('basic', () => {
  expect(main('world')).toBe('world');
});
