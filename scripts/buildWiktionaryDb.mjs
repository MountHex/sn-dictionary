import {readFile, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';

import {parseIfo} from '../src/core/dict/stardict/parseIfo.ts';
import {parseIdx} from '../src/core/dict/stardict/parseIdx.ts';
import {parseSyn} from '../src/core/dict/stardict/parseSyn.ts';
import {createDictReader} from '../src/core/dict/stardict/dictReader.ts';
import {
  splitDictEntry,
  sanitizeDefinition,
} from '../src/core/dict/stardict/dictEntry.ts';
import {normalizeKey} from '../src/core/dict/normalizeKey.ts';
import {decodeUtf8} from '../src/sdk/utf8.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const SOURCE_DIR = join(PROJECT_ROOT, 'dict', 'wiktionary');
const OUT_DIR = join(PROJECT_ROOT, 'build');
const OUT_FILE = join(OUT_DIR, 'wiktionary.db');

const IFO = join(SOURCE_DIR, 'en-en.ifo');
const IDX = join(SOURCE_DIR, 'en-en.idx');
const DICT = join(SOURCE_DIR, 'en-en.dict.dz');
const SYN = join(SOURCE_DIR, 'en-en.syn');

const log = (...args) => console.log(...args);

const main = async () => {
  log('[wiktionary] reading source files...');

  const [ifoBytes, idxBytes, dictBytes, synBytes] = await Promise.all([
    readFile(IFO),
    readFile(IDX),
    readFile(DICT),
    readFile(SYN),
  ]);

  const meta = parseIfo(ifoBytes);

  log(
    `[wiktionary] ${meta.bookname} — ${meta.wordcount} headwords, ` +
      `${meta.synwordcount ?? 0} aliases`,
  );

  if (meta.sametypesequence !== 'h') {
    throw new Error(
      `Expected HTML StarDict (sametypesequence=h), got ${meta.sametypesequence}`,
    );
  }

  log('[wiktionary] parsing .idx...');
  const idxEntries = await parseIdx(idxBytes, meta.idxoffsetbits);

  log('[wiktionary] parsing .syn...');
  const synEntries = await parseSyn(synBytes);

  log('[wiktionary] opening dictionary body...');
  const reader = createDictReader(dictBytes);

  await mkdir(OUT_DIR, {recursive: true});

  const db = new Database(OUT_FILE);

  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;

    DROP VIEW IF EXISTS entries;
    DROP TABLE IF EXISTS lookup_keys;
    DROP TABLE IF EXISTS definitions;

    CREATE TABLE definitions (
      id INTEGER PRIMARY KEY,
      word TEXT NOT NULL,
      definition TEXT NOT NULL,
      format TEXT NOT NULL,
      phonetic TEXT
    );

    CREATE TABLE lookup_keys (
      key TEXT PRIMARY KEY,
      definition_id INTEGER NOT NULL
    );
  `);

  const insertDefinition = db.prepare(`
    INSERT INTO definitions
      (id, word, definition, format, phonetic)
    VALUES
      (?, ?, ?, 'html', NULL)
  `);

  const insertKey = db.prepare(`
    INSERT OR IGNORE INTO lookup_keys
      (key, definition_id)
    VALUES
      (?, ?)
  `);

  log('[wiktionary] writing canonical definitions and keys...');

  const writeDefinitions = db.transaction(() => {
    for (let i = 0; i < idxEntries.length; i++) {
      const entry = idxEntries[i];

      const raw = reader.slice(entry.offset, entry.length);
      const {payload} = splitDictEntry(
        meta.sametypesequence ?? null,
        raw,
      );

      const definition = sanitizeDefinition(decodeUtf8(payload));

      insertDefinition.run(
        i,
        entry.word,
        definition,
      );

      const key = normalizeKey(entry.word);
      if (key.length > 0) {
        insertKey.run(key, i);
      }

      if ((i + 1) % 50000 === 0) {
        log(
          `[wiktionary] definitions: ${i + 1}/${idxEntries.length}`,
        );
      }
    }
  });

  writeDefinitions();

  log('[wiktionary] writing alias keys...');

  const writeAliases = db.transaction(() => {
    for (let i = 0; i < synEntries.length; i++) {
      const syn = synEntries[i];

      if (
        syn.originalWordIndex < 0 ||
        syn.originalWordIndex >= idxEntries.length
      ) {
        continue;
      }

      const key = normalizeKey(syn.word);
      if (key.length > 0) {
        // INSERT OR IGNORE preserves the plugin's existing
        // first-key-wins lookup semantics.
        insertKey.run(key, syn.originalWordIndex);
      }

      if ((i + 1) % 100000 === 0) {
        log(
          `[wiktionary] aliases: ${i + 1}/${synEntries.length}`,
        );
      }
    }
  });

  writeAliases();

  db.exec(`
    CREATE INDEX idx_lookup_definition
      ON lookup_keys(definition_id);

    CREATE VIEW entries AS
      SELECT
        k.key AS key,
        d.word AS word,
        d.definition AS definition,
        d.format AS format,
        d.phonetic AS phonetic
      FROM lookup_keys k
      JOIN definitions d
        ON d.id = k.definition_id;
  `);

  const definitionCount = db
    .prepare('SELECT count(*) AS n FROM definitions')
    .get().n;

  const keyCount = db
    .prepare('SELECT count(*) AS n FROM lookup_keys')
    .get().n;

  log(
    `[wiktionary] stored ${definitionCount} definitions and ${keyCount} lookup keys`,
  );

  log('[wiktionary] compacting database...');
  db.exec('VACUUM');

  const integrity = db
    .prepare('PRAGMA integrity_check')
    .get();

  log(`[wiktionary] integrity_check: ${integrity.integrity_check}`);

  db.close();

  log(`[wiktionary] wrote ${OUT_FILE}`);
};

main().catch(err => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
