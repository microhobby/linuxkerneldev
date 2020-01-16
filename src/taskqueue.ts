'use strict';

interface IEnqueuedTask {
  execute: () => void;
  promise: () => Promise<any>;
}

class TypedTask<T> implements IEnqueuedTask {
  private func: () => T | Promise<T>;
  private p: Promise<T>;
  private rs: ((result: T) => void) | undefined;
  private rj: ((reason: any) => void) | undefined;

  constructor(func: () => T | Promise<T>) {
    this.func = func;
    this.p = new Promise<T>((resolve, reject) => {
      this.rs = resolve;
      this.rj = reject;
    });
  }

  public execute() {
    const result = this.func();
    if (result instanceof Promise) {
      result.then(this.resolve.bind(this)).catch(this.reject.bind(this));
    } else {
      this.resolve(result);
    }
  }

  public promise(): Promise<T> {
    return this.p;
  }

  private resolve(result: T) {
    this.rs!(result);
  }

  private reject(reason: any) {
    this.rj!(reason);
  }
}

export class TaskQueue {
  private tasks: IEnqueuedTask[];
  private idle: IEnqueuedTask[];
  private executing: IEnqueuedTask | null;

  constructor() {
    this.tasks = [];
    this.idle = [];
    this.executing = null;
  }

  public append<T>(task: () => T, idle?: boolean): Promise<T> {
    const t = new TypedTask<T>(task);
    if (!idle) {
      this.tasks.push(t);
    } else {
      this.idle.push(t);
    }
    this.poke();
    return t.promise();
  }

  private poke() {
    if (!this.executing) {
      const t = this.tasks.shift() || this.idle.shift();
      if (t) {
        this.executing = t;
        this.executing
          .promise()
          .then(this.finished.bind(this))
          .catch(this.finished.bind(this));
        this.executing.execute();
      }
    }
  }

  private finished() {
    this.executing = null;
    this.poke();
  }
}
