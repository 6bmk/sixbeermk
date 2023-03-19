import { createReadStream } from 'fs';
import { modifyZip } from './zip.js';

export async function createFlyer(options = {}) {
  const {
    paper = 'letter',
    orientation = 'portrait',
    mode = 'simplex',
    file,
    haiku,
    address = '',
    instructions = '',
  } = options;
  const path = (file) ? file : new URL(`../pptx/flyer-${paper}-${orientation}-${mode}.pptx`, import.meta.url).pathname;
  const stream = createReadStream(path);
  return modifyZip(stream, (name) => {
    const haikuHash = {};
    // return function that modify the XML file
    if (/^ppt\/slides\/slide\d+.xml$/.test(name)) {
      if (typeof(haiku?.[Symbol.asyncIterator]) !== 'function') {
        throw new Error(`Missing haiku generator`);
      }  
      return async (buffer) => {
        const text = buffer.toString();
        const vars = extractVariables(text);
        const variables = {};
        for (const varname of vars) {
          let m;
          if (m = /^tab_\d+_heading$/.exec(varname)) {
            variables[varname] = address;
          } else if (m = /^tab_(\d+)_line_(\d+)$/.exec(varname)) {
            const tag = m[1], line = m[2];
            let lines = haikuHash[tag];
            if (!lines) {
              // generate the haiku
              const { done, value } = await haiku.next();          
              if (!done) {
                lines = haikuHash[tag] = value.split('\n');
              }
            }
            if (lines) {
              variables[varname] = lines[line - 1];
            }
          }
        }
        variables['body_instruction_text'] = instructions;
        return text.replace(/\$\{(.*?)\}/g, (placeholder, name) => {
          return variables.hasOwnProperty(name) ? variables[name] : placeholder;
        });
      };
    } else if (name === null) {
      return () => haiku?.return();
    }
  });
}

function extractVariables(text) {
  const re = /\$\{(.*?)\}/g;
  const names = [];
  let m;
  while (m = re.exec(text)) {
    names.push(m[1]);
  }
  return names.sort();
}