import { expect } from 'chai';
import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream';

import {
  modifyZip,
  createZip,
} from '../src/zip.js';

describe('Zip functions', function() {
  describe('#modifyZip()', function() {
    it ('should find files inside archive', async function() {
      const names = [];
      const path = resolve('./files/three-files.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      const outStream = modifyZip(chunkedStream, name => names.push(name));
      for await (const chunk of outStream) {}
      expect(names).to.contains('three-files/');
      expect(names).to.contains('three-files/LICENSE.txt');
      expect(names).to.contains('three-files/donut.txt');
      expect(names).to.contains('three-files/malgorzata-socha.jpg');
    })
    it ('should find extract contents from small uncompressed file', async function() {
      const path = resolve('./files/three-files.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      let text = '';
      const outStream = modifyZip(chunkedStream, (name) => {
        if (name === 'three-files/donut.txt') {
          return async (buffer) => {
            text = buffer.toString();
            return buffer;
          };
        }
      });
      for await (const chunk of outStream) {}
      expect(text).to.contains('${placeholder}');
    })
    it ('should remove file when transform function return null', async function() {
      const path = resolve('./files/three-files.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      const outStream1 = modifyZip(chunkedStream, (name) => {
        if (name === 'three-files/malgorzata-socha.jpg') {
          return async (buffer) => {
            return null;
          };
        }
      });
      const names = [];
      const outStream2 = modifyZip(outStream1, name => names.push(name));
      for await (const chunk of outStream2) {}
      expect(names).to.contains('three-files/');
      expect(names).to.contains('three-files/LICENSE.txt');
      expect(names).to.contains('three-files/donut.txt');
      expect(names).to.not.contains('three-files/malgorzata-socha.jpg');
    })
    it ('should replace file contents', async function() {
      const path = resolve('./files/three-files.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      const replacement = 'wasabi donut';
      const outStream1 = modifyZip(chunkedStream, (name) => {
        if (name === 'three-files/donut.txt') {
          return async (buffer) => {
            const text = buffer.toString();
            return text.replace('${placeholder}', replacement);
          };
        }
      });
      let text = '';
      const outStream2 = modifyZip(outStream1, (name) => {
        if (name === 'three-files/donut.txt') {
          return async (buffer) => {
            text = buffer.toString();
            return buffer;
          };
        }
      });
      for await (const chunk of outStream2) {}
      expect(text).to.contains(replacement);
    })
    it ('should replace contents of larger compressed file', async function() {
      const path = resolve('./files/three-files.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      const replacement = 'Road to Serfdom';
      const outStream1 = modifyZip(chunkedStream, (name) => {
        if (name === 'three-files/LICENSE.txt') {
          return async (buffer) => {
            const text = buffer.toString();
            const newText = text.replace('General Public License', replacement);
            return Buffer.from(newText);
          };
        }
      });
      let text = '';
      const outStream2 = modifyZip(outStream1, (name) => {
        if (name === 'three-files/LICENSE.txt') {
          return async (buffer) => {
            text = buffer.toString();
            return buffer;
          };
        }
      });
      for await (const chunk of outStream2) {}
      expect(text).to.contains(replacement);
    })
    it ('should find file with unicode name', async function() {
      const names = [];
      const path = resolve('./files/unicode.zip');
      const fileStream = createReadStream(path);
      const chunkedStream = createChunkyStream(fileStream, 1024);
      const outStream = modifyZip(chunkedStream, name => names.push(name));
      for await (const chunk of outStream) {}
      expect(names).to.contains('szczęście.txt');
    })
    it ('should produce valid PowerPoint file', async function() {
      const site = 'https://6beer.mk';
      const haiku = [
        [ 'Harass explosives', 'Otherworldly paul playoff', 'Stalks polje weeny' ],
        [ 'Grouping sandstorm soon', 'Tine doorway bookmark agile', 'Verbatim coldly' ],
        [ 'Polymorphism baas', 'Accompli shoved murine jo', 'Fruitlessly speaker' ],
        [ 'Whet berth suspender', 'Disproportionate sadness', 'Tiptoe sympathized' ],
        [ 'Morgana mantra', 'Ais inhabiting umpteen', 'Disestablishment' ],
        [ 'Upstate brock nighttimes', 'Hartmann condone enterprise', 'Disrupted abie' ],
        [ 'Outlook prettiest', 'Defies program hitchhiker', 'Demote cistercian' ],
        [ 'Acquittal luau', 'Drafting mirabel parrot', 'Hognose dunked cellar' ],
        [ 'Hakes encourages', 'Handsome yew dowd bove starchy', 'Swelling curmudgeons' ],
        [ 'Chugging importer', 'Squabble finalists sputters', 'Fillers vibrant penned' ],
      ];
      const instructions = `Instructions: Go to ${site} and type in one of the following infinite-monkey haiku`;
      const variables = [];
      for (const [ index, lines ] of haiku.entries()) {
        variables[`tab_${index + 1}_heading`] = site;
        for (const [ lineIndex, line ] of lines.entries()) {
          variables[`tab_${index + 1}_line_${lineIndex + 1}`] = line;
        }
      }
      variables['body_instruction_text'] = instructions;
      const path = resolve('../pptx/flyer-a4-portrait.pptx');
      const fileStream = createReadStream(path);
      const outStream = modifyZip(fileStream, (name) => {
        if (name === 'ppt/slides/slide1.xml') {
          return async (buffer) => {
            const text = buffer.toString();
            return text.replace(/\$\{(.*?)\}/g, (placeholder, varname) => {
              return variables[varname] || '';
            });
          };
        }
      });
      // need to check file manually
      const pptxPath = resolve('./files/output/flyer.pptx');
      const pptxFileStream = createWriteStream(pptxPath);
      await pipe(outStream, pptxFileStream);
    })
  })
  describe('#createZip', function() {
    it ('should create a valid zip file', async function() {
      const inText1 = 'Hello world\n';
      const inText2 = inText1.repeat(300);
      const zipStream = createZip([
        { name: 'hello1.txt', data: Buffer.from(inText1) },
        { name: 'hello2.txt', data: Buffer.from(inText2), isText: true },
        { name: 'world/', isFile: false },
      ]);
      let outText;
      const outStream = modifyZip(zipStream, (name) => {
        if (name === 'hello2.txt') {
          return async (buffer) => {
            outText = buffer.toString();
            return buffer;
          };
        }
      });
      // need to check file manually
      const zipPath = resolve('./files/output/test1.zip');
      const zipFileStream = createWriteStream(zipPath);
      await pipe(outStream, zipFileStream);
      expect(outText).to.equal(inText2);
    })
  })
})

function createChunkyStream(stream, size) {
  const process = async function*() {
    for await (const chunk of stream) {
      for (let i = 0; i < chunk.length; i += size) {
        yield chunk.subarray(i, i + size);
      }
    }
  };
  return Readable.from(process());
}

async function pipe(source, dest) {
  await new Promise((resolve, reject) => {
    pipeline(source, dest, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function resolve(path) {
  return (new URL(path, import.meta.url)).pathname;
}
