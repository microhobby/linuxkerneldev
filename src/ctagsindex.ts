import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { TextIndexer } from 'textindexer';
import * as util from './util';

function regexEscape(s: string): string {
  // modified version of the regex escape from 1.
  // we don't need to escape \ or / since the no-magic
  // ctags pattern already escapes these
  // 1. https://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
  return s.replace(/[-^$*+?.()|[\]{}]/g, '\\$&');
}

export interface Tag {
  name: string;
  path: string;
  pattern: string;
}

export interface Match {
  symbol: string;
  path: string;
  lineno: number;
}

export class CTagsIndex {
  private baseDir: string;
  private filename: string;
  private indexer: TextIndexer;

  constructor(baseDir: string, filename: string) {
    this.baseDir = baseDir;
    this.filename = filename;
    this.indexer = new TextIndexer(
      path.join(this.baseDir, filename),
      line => {
        const ti = line.indexOf('\t');
        return ti !== -1 ? line.slice(0, ti) : line;
      },
      7
    );
  }

  public async build(): Promise<void> {
    await this.indexer.index();
  }

  public async lookup(symbol: string): Promise<Match[] | null> {
    const candidates = await this.lookupRange(symbol);
    if (candidates) {
      const matches = candidates.filter((candidate) => {
        return candidate.name === symbol;
      });
      return Promise.all<Match>(matches.map(this.resolveMatch.bind(this)));
    }
    return null;
  }

  public async lookupCompletions(prefix: string): Promise<Tag[] | null> {
    const candidates = await this.lookupRange(prefix);
    if (candidates) {
      const found = new Set();
      const matches = candidates.filter((candidate) => {
        if (candidate.name.startsWith(prefix) && !found.has(candidate.name)) {
          found.add(candidate.name);
          return true;
        }
        return false;
      });
      return matches;
    }
    return null;
  }

  private async lookupRange(symbol: string): Promise<Tag[] | null> {
    const matchedRange = await this.indexer.lookup(symbol);
    if (!matchedRange) {
      return Promise.resolve(null);
    }
    const tags: Tag[] = [];
    const rs = fs.createReadStream(path.join(this.baseDir, this.filename), {
      start: matchedRange.start,
      end: matchedRange.end
    });
    const lr = readline.createInterface(rs);
    lr.on('line', line => {
      const tokens = line.split('\t');
	let pp = "";

	for (let i: number = 2; i < tokens.length; i++) {
		if (tokens[i].indexOf("/;\"") != -1) {
			pp += tokens[i];
			break;
		} else {
			pp += tokens[i] + "\t";
		}
	}

        tags.push({
	  	name: tokens[0],
		path: tokens[1],
          	pattern: pp
        });
    });
    return new Promise<Tag[]>((resolve, reject) => {
      lr.on('close', () => {
        rs.destroy();
        resolve(tags);
      });
      rs.on('error', () => {
        rs.destroy();
        reject();
      });
    });
  }

  private parsePattern(token: string): RegExp | number | null {
    if (token.startsWith('/^') && token.endsWith('/;"')) {
      // tag pattern is a no-magic pattern with start and possibly end anchors (/^...$/)
      // http://vimdoc.sourceforge.net/htmldoc/pattern.html#/magic
      // http://ctags.sourceforge.net/FORMAT
      const anchoredEol = token.endsWith('$/;"');
      const end = anchoredEol ? -4 : -3;
      return new RegExp(
        '^' + regexEscape(token.slice(2, end)) + (anchoredEol ? '$' : '')
      );
    }
    const lineno = parseInt(token, 10);
    if (!isNaN(lineno)) {
      return lineno - 1;
    }
    return null;
  }

  private resolveMatch(tag: Tag): Promise<Match> {
    const pattern = this.parsePattern(tag.pattern);
    if (typeof pattern === 'number') {
      return Promise.resolve({
        symbol: tag.name,
        lineno: pattern,
        path: path.join(this.baseDir, tag.path)
      });
    }
    return this.findTagInFile(tag.name, pattern, path.join(this.baseDir, tag.path));
  }

  private findTagInFile(
    symbol: string,
    pattern: RegExp | null,
    filename: string
  ): Promise<Match> {
    const match = { symbol, lineno: 0, path: filename };
    if (!pattern) {
      return Promise.resolve(match);
    }
    const rs = fs.createReadStream(filename);
    const rl = readline.createInterface({ input: rs });
    return new Promise<Match>((resolve, _) => {
      let lineno = 0;
      rl.on('line', line => {
        if (pattern.test(line)) {
          match.lineno = lineno;
          rl.close();
        }
        lineno++;
      });
      rl.on('close', () => {
        rs.destroy();
        resolve(match);
      });
      rs.on('error', (error: string) => {
        util.log('findTagsInFile:', error);
        rs.destroy();
        resolve(match);
      });
    });
  }
}
