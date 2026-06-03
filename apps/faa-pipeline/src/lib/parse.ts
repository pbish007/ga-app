/**
 * Count data records in a FAA fixed-width file.
 *
 * FAA releasable database files ship as CSV-ish text with a single header row,
 * trailing CRLFs, and sometimes a trailing blank line. Records = non-empty
 * lines - 1 (for the header).
 *
 * Counting is done on the raw buffer to avoid materialising the whole file as
 * a UTF-8 string (these files are ~80–100 MB).
 */
export function countRecords(buf: Buffer): number {
  const NL = 0x0a;
  const CR = 0x0d;
  let total = 0;
  let inLine = false;

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === NL) {
      if (inLine) total++;
      inLine = false;
    } else if (c === CR) {
      // ignore — counted on the NL or EOF
    } else {
      inLine = true;
    }
  }
  if (inLine) total++; // file didn't end with a newline

  return total === 0 ? 0 : total - 1; // strip the header
}
