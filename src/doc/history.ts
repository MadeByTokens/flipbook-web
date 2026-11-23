// One undo history for everything: strokes, frames and settings, in the order
// they happened. Actions may be asynchronous (a drawing might have to be
// loaded first), so they run strictly one at a time.

export interface Action {
  /** Approximate memory held by this action. */
  readonly bytes: number;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

export class History {
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  private bytes = 0;
  private running = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly budgetBytes: number,
    private readonly onChange: () => void = () => {},
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** True while an undo or redo is still being applied. */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Records an action that has already been carried out. */
  push(action: Action): void {
    for (const a of this.redoStack) this.bytes -= a.bytes;
    this.redoStack = [];
    this.undoStack.push(action);
    this.bytes += action.bytes;
    // Forget the oldest actions once over budget, always keeping the newest.
    while (this.bytes > this.budgetBytes && this.undoStack.length > 1) {
      this.bytes -= this.undoStack.shift()!.bytes;
    }
    this.onChange();
  }

  undo(): Promise<void> {
    return this.step(this.undoStack, this.redoStack, (a) => a.undo());
  }

  redo(): Promise<void> {
    return this.step(this.redoStack, this.undoStack, (a) => a.redo());
  }

  private step(from: Action[], to: Action[], run: (a: Action) => void | Promise<void>): Promise<void> {
    this.running++;
    this.chain = this.chain.then(async () => {
      const action = from.pop();
      try {
        if (action) {
          await run(action);
          to.push(action);
        }
      } finally {
        this.running--;
        this.onChange();
      }
    });
    return this.chain;
  }
}
