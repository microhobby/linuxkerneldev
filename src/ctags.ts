'use strict';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { rename, stat, Stats } from 'fs';
import * as path from 'path';
import { CTagsIndex, Match, Tag } from './ctagsindex';
import { TaskQueue } from './taskqueue';
import { log } from './util';

export class CTags {
  private baseDir: string;
  private filename: string;
  private index: CTagsIndex;
  private indexq: TaskQueue;
  private fileq: TaskQueue;

  constructor(baseDir: string, filename: string) {
    this.baseDir = baseDir;
    this.filename = filename;
    this.index = new CTagsIndex(this.baseDir, this.filename);
    this.indexq = new TaskQueue();
    this.fileq = new TaskQueue();
  }

  public async reindex() {
    await this.fileq.append(async () => {
      await this.statAsync(path.join(this.baseDir, this.filename));
      log('found existing tags file.');
      await this.indexq.append(async () => {
        await this.index.build();
        log('indexed tags.');
      }, true);
    });
  }

  public async regenerate(args?: string[]): Promise<void> {
    log('enqueing regenerate ctags task.');
    await this.fileq.append(async () => {
      await this.regenerateFile(args);
      log('regenerated ctags.');
      await this.indexq.append(async () => {
        await this.swapTagFile();
        log('installed tags.');
        await this.index.build();
        log('indexed tags.');
      }, true);
    });
  }

  public async lookup(symbol: string): Promise<Match[] | null> {
    log(`enqueing lookup: "${symbol}".`);
    return this.indexq.append(() => {
      return this.index.lookup(symbol);
    });
  }

  public async lookupCompletions(prefix: string): Promise<Tag[] | null> {
    log(`enqueing lookup completions: "${prefix}".`);
    return this.indexq.append(() => {
      return this.index.lookupCompletions(prefix);
    });
  }

  private regenerateFile(args?: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const config = vscode.workspace.getConfiguration('ctags');
		  const useDocker = config.get<boolean>('useDocker');
      let command: string = "";

      if (!useDocker) {
        command = ['ctags']
          .concat(args || [])
          //.concat([`-x`, `--_xformat='%{name}\t%{file}\t%{tagaddress}'`])
          .concat([`-R`])
          .concat([`-f`, this.filename + '.next', '.'])
          .join(' ');
      } else {
        command = ['docker']
          .concat('run', '--rm')
          .concat('-v', `${vscode.workspace.rootPath!}:/bindmount`)
          .concat('seadoglinux/ctags')
          .concat(args || [])
          //.concat([`-x`, `--_xformat='%{name}\t%{file}\t%{tagaddress}'`])
          .concat([`-R`])
          .concat([`-f`, this.filename + '.next', '.'])
          .join(' ');
      }
      
      child_process.exec(
        command,
        { cwd: this.baseDir },
        (err, stdout, stderr) => {
          if (err) {
            log(command, err, stdout, stderr);
            reject(stderr);
          }
          resolve();
        }
      );
    });
  }

  private swapTagFile(): Promise<void> {
    return new Promise((resolve, _) => {
      rename(
        path.join(this.baseDir, this.filename + '.next'),
        path.join(this.baseDir, this.filename),
        err => {
          if (err) {
            log('rename:' + err);
          }
          resolve();
        }
      );
    });
  }

  private statAsync(filename: string): Promise<Stats> {
    return new Promise<Stats>((resolve, reject) => {
      stat(filename, (err, stats) => {
        if (err) {
          reject(err);
        } else {
          resolve(stats);
        }
      });
    });
  }
}
