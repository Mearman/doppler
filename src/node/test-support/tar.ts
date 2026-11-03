/** Builders for tar streams used by the reader's tests. */

/** Bytes in a tar block. */
export const BLOCK = 512;

/** Bytes of a ustar header's name field; a longer name is truncated, as a GNU tar long-name entry would carry the rest. */
const NAME_FIELD_BYTES = 100;

/** Offset of a ustar header's size field, which holds the data length as octal text. */
const SIZE_FIELD_OFFSET = 124;

/** Digits of octal text in the size field; the twelfth byte is the terminating NUL. */
const SIZE_FIELD_DIGITS = 11;

/** Offset of a ustar header's one-character type flag. */
const TYPE_FIELD_OFFSET = 156;

/** The size field is written in octal. */
const OCTAL_RADIX = 8;

/** Builds one tar entry: a 512-byte ustar header followed by the data padded to a block. */
export function tarEntry(name: string, data: Readonly<Uint8Array>, type = '0'): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name.length > NAME_FIELD_BYTES ? name.slice(0, NAME_FIELD_BYTES) : name, 0, 'utf8');
  header.write(`${data.length.toString(OCTAL_RADIX).padStart(SIZE_FIELD_DIGITS, '0')}\0`, SIZE_FIELD_OFFSET, 'ascii');
  header.write(type, TYPE_FIELD_OFFSET, 'ascii');
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);

  return Buffer.concat([header, Buffer.from(data), padding]);
}

/** Two zero blocks end an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2);
