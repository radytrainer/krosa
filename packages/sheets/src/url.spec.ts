import { parseSpreadsheetUrl } from './url.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy';

describe('parseSpreadsheetUrl', () => {
  it.each([
    `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`,
    `https://docs.google.com/spreadsheets/d/${ID}`,
    `https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`,
    `  https://docs.google.com/spreadsheets/d/${ID}/  `,
  ])('extracts the ID from %s', (url) => {
    expect(parseSpreadsheetUrl(url)).toEqual({ ok: true, spreadsheetId: ID });
  });

  it.each([
    ['', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    [`http://docs.google.com/spreadsheets/d/${ID}/edit`, 'UNSUPPORTED_HOST'],
    [`https://docs.google.com.evil.example/spreadsheets/d/${ID}`, 'UNSUPPORTED_HOST'],
    [`https://evil.example/docs.google.com/spreadsheets/d/${ID}`, 'UNSUPPORTED_HOST'],
    [`https://user:pw@docs.google.com/spreadsheets/d/${ID}`, 'UNSUPPORTED_HOST'],
    [`https://docs.google.com:8443/spreadsheets/d/${ID}`, 'UNSUPPORTED_HOST'],
    [`https://drive.google.com/file/d/${ID}/view`, 'UNSUPPORTED_HOST'],
    [`https://docs.google.com/document/d/${ID}/edit`, 'NOT_A_SPREADSHEET_URL'],
    [
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml',
      'NOT_A_SPREADSHEET_URL',
    ],
    ['https://docs.google.com/spreadsheets/d/short/edit', 'NOT_A_SPREADSHEET_URL'],
    [`https://docs.google.com/spreadsheets/d/${ID}%2F..%2Fx/edit`, 'NOT_A_SPREADSHEET_URL'],
  ])('rejects %j with %s', (url, code) => {
    expect(parseSpreadsheetUrl(url)).toMatchObject({ ok: false, code });
  });
});
