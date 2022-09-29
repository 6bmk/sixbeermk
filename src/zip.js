import { Readable } from 'stream';
import { inflateRaw, deflateRaw } from 'zlib';

export function modifyZip(stream, cb) {
  const processStream = async function*() {
    let leftOver = null;
    let extraction = null;
    let dataRemaining = 0;
    let currentOffset = 0;
    let localHeaderOffsets = {};
    let centralDirectoryOffset = 0;
    let centralDirectorySize = 0;
    let centralDirectoryRecordCount = 0;
    let transformedFileAttributes = {};
    let omitDataDescriptor = false;
    for await (let chunk of stream) {
      if (leftOver) {
        chunk = Buffer.concat([ leftOver, chunk ]);
        leftOver = null;
      }
      let index = 0;
      while (index < chunk.length) {
        if (dataRemaining === 0) {
          // expecting a header of some sort
          try {
            const signature = chunk.readUInt32LE(index);
            if (signature === 0x04034b50) {
              const nameLength = chunk.readUInt16LE(index + 26);
              const extraLength = chunk.readUInt16LE(index + 28);
              const headerSize = 30 + nameLength + extraLength;
              const header = getBufferSlice(chunk, index, headerSize);
              const flags = header.readUInt16LE(6);
              const compression = header.readUInt16LE(8);
              const compressedSize = header.readUInt32LE(18);
              const name = extractName(header, 30, nameLength, flags);
              const transform = cb(name) || null;
              if (transform instanceof Function) {
                // callback wants a look at the data
                extraction = { header, flags, name, compression, transform, data: [] };
                omitDataDescriptor = true;
              } else {
                // just output the header
                localHeaderOffsets[name] = currentOffset;
                currentOffset += header.length;
                omitDataDescriptor = false;
                yield header;
              }
              index += header.length;
              dataRemaining = compressedSize;
            } else if (signature === 0x08074b50) {
              // data descriptor
              const descriptor = getBufferSlice(chunk, index, 16);
              if (!omitDataDescriptor) {
                currentOffset += descriptor.length;
                yield descriptor;
              }
              index += descriptor.length;
            } else if (signature === 0x02014b50) {
              const nameLength = chunk.readUInt16LE(index + 28);
              const extraLength = chunk.readUInt16LE(index + 30);
              const commentLength = chunk.readUInt16LE(index + 32)
              const headerSize = 46 + nameLength + extraLength + commentLength;
              const header = getBufferSlice(chunk, index, headerSize);
              const flags = header.readUInt16LE(8);
              const name = extractName(header, 46, nameLength, flags);
              const localHeaderOffset = localHeaderOffsets[name];
              if (localHeaderOffset !== undefined) {
                // update local header position
                header.writeUInt32LE(localHeaderOffset, 42);
                const newAttributes = transformedFileAttributes[name];
                if (newAttributes) {
                  const { crc32, compressedSize, uncompressedSize } = newAttributes;
                  // update these as well
                  header.writeUInt16LE(flags & ~0x0008, 8);
                  header.writeUInt32LE(crc32, 16);
                  header.writeUInt32LE(compressedSize, 20);
                  header.writeUInt32LE(uncompressedSize, 24);
                }
                if (centralDirectoryOffset === 0) {
                  centralDirectoryOffset = currentOffset;
                }
                centralDirectoryRecordCount++;
                centralDirectorySize += header.length;
                currentOffset += header.length;
                yield header;
              }
              index += header.length;
            } else if (signature === 0x06054b50) {
              // end of central directory record
              const commentLength = chunk.readUInt16LE(index + 20)
              const headerSize = 22 + commentLength;
              const header = getBufferSlice(chunk, index, headerSize);
              // update record
              header.writeUInt16LE(centralDirectoryRecordCount, 8);
              header.writeUInt16LE(centralDirectoryRecordCount, 10);
              header.writeUInt32LE(centralDirectorySize, 12);
              header.writeUInt32LE(centralDirectoryOffset, 16);
              currentOffset += header.length;
              yield header;
              index += header.length;
            } else {
              stream.destroy();
              throw new Error(`Unknown signature ${signature.toString(16)}`);
            }
          } catch (err) {
            if (err instanceof RangeError) {
              // need more data before we can process the header
              leftOver = chunk.subarray(index);
              index += leftOver.length;
            } else {
              throw err;
            }
          }
        } else {
          // processing the data contents
          // get up to the number of bytes remaining from the chunk
          const data = chunk.subarray(index, index + dataRemaining);
          if (extraction) {
            // keep the data
            extraction.data.push(data);
          } else {
            // send the data to the output stream
            currentOffset += data.length;
            yield data;
          }
          index += data.length;
          dataRemaining -= data.length;
          if (dataRemaining === 0 && extraction) {
            const { header, flags, name, compression, transform, data } = extraction;
            const uncompressedData = await decompressData(data, compression);
            let transformedData = await transform(uncompressedData);
            if (!(transformedData instanceof Buffer) && transformedData != null) {
              transformedData = Buffer.from(transformedData);
            }
            if (transformedData instanceof Buffer) {
              const crc32 = calcuateCRC32(transformedData);
              const compressedData = await compressData(transformedData, compression);
              const compressedSize = compressedData.length;
              const uncompressedSize = transformedData.length;
              // remember these for the central directory
              transformedFileAttributes[name] = { crc32, compressedSize, uncompressedSize };
              localHeaderOffsets[name] = currentOffset;
              // update header
              const flagsOrg = header.readUInt16LE(6);
              header.writeUInt16LE(flags & ~0x0008, 6);
              header.writeUInt32LE(crc32, 14);
              header.writeUInt32LE(compressedSize, 18);
              header.writeUInt32LE(uncompressedSize, 22);
              // output the header and transformed data
              currentOffset += header.length + compressedData.length;
              yield header;
              yield compressedData;
            } else if (transformedData !== null) {
              stream.destroy();
              throw new Error('Transform function did not return a Buffer object or null');
            }
            extraction = null;
          }
        }
      }
    }
  };
  return Readable.from(processStream());
}

export function createZip(items) {
  const processStream = async function*() {
    const zipVersion = 20;
    const lastModified = getDOSDatetime(new Date);
    const centralDirectory = [];
    let currentOffset = 0;
    // local headers and data
    for await (const { name, data, comment, isFile = true, isText = false } of items) {
      // calculate CRC32 and compress data
      const crc32 = (data) ? calcuateCRC32(data) : 0;
      const compression = (data && data.length > 32) ? 8 : 0;
      const compressedData = (data) ? await compressData(data, compression) : null;
      // create local header
      const flags = 0x0800;
      const nameLength = Buffer.byteLength(name);
      const commentLength = (comment) ? Buffer.byteLength(comment) : 0;
      const extraLength = 0;
      const compressedSize = (compressedData) ? compressedData.length : 0;
      const uncompressedSize = (data) ? data.length : 0;
      const internalAttributes = (isText) ? 0x0001 : 0x0000;
      const externalAttributes = (isFile) ? 0x0080 : 0x0010;
      const headerOffset = currentOffset;
      const headerSize = 30 + nameLength + extraLength;
      const header = Buffer.alloc(headerSize);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(zipVersion, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(compression, 8);
      header.writeUInt32LE(lastModified, 10);
      header.writeUInt32LE(crc32, 14);
      header.writeUInt32LE(compressedSize, 18);
      header.writeUInt32LE(uncompressedSize, 22);
      header.writeUInt16LE(nameLength, 26);
      header.writeUInt16LE(extraLength, 28);
      header.write(name, 30);
      // save info for central directory
      const record = {
        flags,
        compression,
        lastModified,
        crc32,
        compressedSize,
        uncompressedSize,
        nameLength,
        extraLength,
        commentLength,
        internalAttributes,
        externalAttributes,
        headerOffset,
        name,
        comment,
      };
      centralDirectory.push(record);
      // output data
      currentOffset += header.length;
      yield header;
      if (compressedData) {
        currentOffset += compressedData.length;
        yield compressedData;
      }
    }
    // central directory
    const centralDirectoryOffset = currentOffset;
    for (const record of centralDirectory) {
      const {
        flags,
        compression,
        lastModified,
        crc32,
        compressedSize,
        uncompressedSize,
        nameLength,
        extraLength,
        commentLength,
        internalAttributes,
        externalAttributes,
        headerOffset,
        name,
        comment,
      } = record;
      const headerSize = 46 + nameLength + extraLength + commentLength;
      const header = Buffer.alloc(headerSize);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(zipVersion, 4);
      header.writeUInt16LE(zipVersion, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(compression, 10);
      header.writeUInt32LE(lastModified, 12);
      header.writeUInt32LE(crc32, 16);
      header.writeUInt32LE(compressedSize, 20);
      header.writeUInt32LE(uncompressedSize, 24);
      header.writeUInt16LE(nameLength, 28);
      header.writeUInt16LE(extraLength, 30);
      header.writeUInt16LE(commentLength, 32);
      header.writeUInt16LE(internalAttributes, 36)
      header.writeUInt32LE(externalAttributes, 38);
      header.writeUInt32LE(headerOffset, 42);
      header.write(name, 46);
      if (comment) {
        header.write(comment, 46 + nameLength + extraLength);
      }
      currentOffset += header.length;
      yield header;
    }
    // end of central directory record
    const centralDirectorySize = currentOffset - centralDirectoryOffset;
    const header = Buffer.alloc(22);
    header.writeUInt32LE(0x06054b50, 0);
    header.writeInt16LE(0, 4);
    header.writeInt16LE(0, 6);
    header.writeInt16LE(centralDirectory.length, 8);
    header.writeInt16LE(centralDirectory.length, 10);
    header.writeUInt32LE(centralDirectorySize, 12);
    header.writeUInt32LE(centralDirectoryOffset, 16);
    header.writeInt16LE(0, 20);
    yield header;
  };
  return Readable.from(processStream());
}

function getBufferSlice(buffer, index, length) {
  if (index + length <= buffer.length) {
    return buffer.subarray(index, index + length);
  } else {
    throw new RangeError(`The value of "length" is out of range.`)
  }
}

function extractName(header, index, length, flags) {
  const raw = header.subarray(index, index + length);
  if (flags & 0x0800) {
    return raw.toString('utf8');
  } else {
    return raw.toString('ascii');
  }
}

async function decompressData(buffers, type) {
  let buffer = (buffers.length === 1) ? buffers[0] : Buffer.concat(buffers);
  if (type === 8) {
    buffer = await new Promise((resolve, reject) => {
      inflateRaw(buffer, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }
  return buffer;
}

async function compressData(buffer, type) {
  if (type === 8) {
    buffer = await new Promise((resolve, reject) => {
      deflateRaw(buffer, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }
  return buffer;
}

function calcuateCRC32(buffer) {
  let crc = initializeCRC32();
  crc = updateCRC32(crc, buffer);
  return finalizeCRC32(crc);
}

let crcTable = null;

function initializeCRC32() {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0, c = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = ((c & 0x01) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      crcTable[n] = c;
    }
  }
  return 0 ^ 0xFFFFFFFF;
}

function finalizeCRC32(crc) {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function updateCRC32(crc, buffer) {
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ view[i]) & 0xff];
  }
  return crc;
}

function getDOSDatetime(date) {
  return (date.getFullYear() - 1980) << 25
       | (date.getMonth() + 1)       << 21
       |  date.getDate()             << 16
       |  date.getHours()            << 11
       |  date.getMinutes()          <<  5
       | (date.getSeconds() >> 1);
}
