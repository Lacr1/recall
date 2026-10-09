// Runs the real indexer in its own process for the crash-loop test (plan S1-08). It prints "T" after every
// indexing step so the test can kill it mid-work; left alone, it indexes until idle, checks the index and prints a summary.
// Usage: node crash-harness.mjs <db path> <folder>   (embeddings come from RECALL_OLLAMA_URL)
import './network-guard'
import { assertIndexConsistent, openDatabase } from '../../src/engine/db'
import { Indexer, UserError } from '../../src/engine/indexer'
import { VectorIndex } from '../../src/engine/vectors'

const [dbPath, folder] = process.argv.slice(2)
const db = openDatabase(dbPath)
const vectors = new VectorIndex(db)
void vectors.size // load the cache now, as the engine does, so indexing updates it incrementally
const indexer = new Indexer(db, vectors, () => process.stdout.write('T\n'), () => undefined)
indexer.setAiReady(true)
indexer.start()
try {
  indexer.addFolder(folder)
} catch (err) {
  if (!(err instanceof UserError && err.code === 'FOLDER_EXISTS')) throw err
}

let stableSince = 0
const timer = setInterval(() => {
  const p = indexer.progress()
  const idle = !p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal
  if (!idle) {
    stableSince = 0
    return
  }
  stableSince ||= Date.now()
  if (Date.now() - stableSince < 600) return
  clearInterval(timer)
  indexer.stop()
  assertIndexConsistent(db)
  // The in-memory vector cache, kept up to date through adds and removals, must match what is stored.
  const stored = (db.prepare('SELECT count(*) n FROM chunk_vectors').get() as { n: number }).n
  process.stdout.write('DONE ' + JSON.stringify({ cacheSize: vectors.size, stored }) + '\n')
  db.close()
  process.exit(0)
}, 100)
