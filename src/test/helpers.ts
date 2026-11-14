import { StudyDatabase } from '@/db/database';
import { createIndexedDbRepositories } from '@/repositories/indexeddb';

let counter = 0;
export function createTestRepos() {
  const db = new StudyDatabase(`test-db-${Date.now()}-${counter++}`);
  return { db, repos: createIndexedDbRepositories(db) };
}
