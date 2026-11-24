import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { serializeAuthenticationRecord, deserializeAuthenticationRecord } from '@azure/identity';

const fields = ['authority', 'homeAccountId', 'clientId', 'tenantId', 'username', 'version'];
const directory = path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'OneMES', 'authentication');
function accountMetadata(value, tenantId) {
  if (!value || fields.some(field => typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 4096)) return undefined;
  if (value.version !== '1.0') return undefined;
  if (tenantId && !['common', 'organizations', 'consumers'].includes(tenantId.toLowerCase()) && value.tenantId.toLowerCase() !== tenantId.toLowerCase()) return undefined;
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

export class MesAuthenticationRecordStore {
  constructor(rootDirectory = directory) { this.directory = rootDirectory; }
  filename(tenantId) {
    const name = createHash('sha256').update(tenantId || 'common').digest('hex');
    return path.join(this.directory, name + '.json');
  }
  async load(tenantId) {
    try {
      const serialized = await readFile(this.filename(tenantId), 'utf8');
      if (serialized.length > 65536) throw new Error('Invalid account record');
      const record = accountMetadata(deserializeAuthenticationRecord(serialized), tenantId);
      if (!record) throw new Error('Invalid account record');
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('MES saved account could not be restored. Sign in from Staging status to save it again.');
      return undefined;
    }
  }
  async save(tenantId, value) {
    const record = accountMetadata(value, tenantId);
    if (!record) return false;
    const target = this.filename(tenantId);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serializeAuthenticationRecord(record), 'utf8'); }
      finally { await file.close(); }
      await rename(temporary, target);
      return true;
    } catch {
      console.warn('MES account could not be remembered for restart. The current sign-in session can still be used.');
      return false;
    } finally {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') console.warn('MES account temporary file could not be cleaned up.');
      });
    }
  }
}
export const mesAuthenticationRecords = new MesAuthenticationRecordStore();
