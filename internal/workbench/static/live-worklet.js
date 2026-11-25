/* Bounded transferable PCM queue. No shared memory or window-timer scheduling. */
class LivePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = new Array(32);
    this.head = 0; this.count = 0; this.frames = 0; this.cursor = 0;
    this.epoch = -1; this.rate = sampleRate; this.capacity = sampleRate * .12;
    this.active = false; this.eof = false; this.started = false; this.starved = false;
    this.consumed = 0; this.consumedBlocks = 0; this.position = 0; this.reportFrames = 0;
    this.fadeFrames = Math.max(1, Math.round(sampleRate * .005));
    this.fade = 0; this.tail = 0; this.lastL = 0; this.lastR = 0;
    this.tailL = 0; this.tailR = 0;
    this.port.onmessage = ({ data }) => this.message(data);
  }
  message(data) {
    if (data.type === 'reset') {
      if (data.epoch < this.epoch) return;
      this.epoch = data.epoch;
      this.blocks.fill(undefined); this.head = 0; this.count = 0;
      this.frames = 0; this.cursor = 0; this.consumed = 0; this.consumedBlocks = 0;
      this.rate = data.sampleRate || this.rate;
      this.capacity = Math.ceil(this.rate * .12);
      this.position = data.position || 0;
      this.active = !!data.active; this.eof = false; this.started = false; this.starved = false;
      this.fade = this.fadeFrames; this.tail = this.fadeFrames;
      this.tailL = this.lastL; this.tailR = this.lastR;
      this.report();
      return;
    }
    if (data.epoch !== this.epoch) return;
    if (data.type === 'start') { this.active = true; this.report(); return; }
    if (data.type === 'eof') { this.eof = true; return; }
    if (data.type !== 'block') return;
    const pcm = data.body;
    const frames = pcm instanceof Float32Array ? pcm.length / 2 : 0;
    if (!Number.isInteger(frames) || frames <= 0 || this.count === this.blocks.length ||
        this.frames - this.cursor + frames > this.capacity + 1) {
      this.port.postMessage({ type: 'overflow', epoch: this.epoch });
      return;
    }
    this.blocks[(this.head + this.count) % this.blocks.length] =
      { pcm, frames, position: data.position, fadeOut: !!data.fadeOut };
    this.count++; this.frames += frames;
    if (this.starved) this.fade = this.fadeFrames;
    this.starved = false;
  }
  report(extra = {}) {
    this.port.postMessage({ type: 'progress', epoch: this.epoch,
      consumed: this.consumed, consumedBlocks: this.consumedBlocks, position: this.position,
      queued: this.frames - this.cursor, buffering: this.active && !this.count, ...extra });
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;
    const left = output[0], right = output[1] || left;
    const ratio = this.rate / sampleRate;
    let underrun = false, ended = false;
    for (let i = 0; i < left.length; i++) {
      let l = 0, r = 0;
      if (this.active && this.count) {
        const block = this.blocks[this.head];
        const frame = Math.floor(this.cursor), fraction = this.cursor - frame;
        const nextBlock = this.count > 1 ? this.blocks[(this.head + 1) % this.blocks.length] : null;
        const contiguous = nextBlock && nextBlock.position === block.position + block.frames;
        const next = frame + 1 < block.frames ? block : contiguous ? nextBlock : block;
        const nextFrame = frame + 1 < block.frames ? frame + 1 : contiguous ? 0 : frame;
        l = block.pcm[frame * 2] + (next.pcm[nextFrame * 2] - block.pcm[frame * 2]) * fraction;
        r = block.pcm[frame * 2 + 1] + (next.pcm[nextFrame * 2 + 1] - block.pcm[frame * 2 + 1]) * fraction;
        let gain = this.fade > 0 ? 1 - this.fade-- / this.fadeFrames : 1;
        if (block.fadeOut) gain *= Math.min(1, (block.frames - this.cursor) / (this.rate * .005));
        l *= gain; r *= gain;
        this.started = true;
        const advance = Math.min(ratio, this.frames - this.cursor);
        this.cursor += advance; this.consumed += advance;
        this.position = block.position + Math.min(this.cursor, block.frames);
        while (this.count && this.cursor >= this.blocks[this.head].frames) {
          const old = this.blocks[this.head];
          this.cursor -= old.frames; this.frames -= old.frames;
          this.blocks[this.head] = undefined;
          this.head = (this.head + 1) % this.blocks.length; this.count--; this.consumedBlocks++;
          if (this.count) {
            const current = this.blocks[this.head];
            if (current.position !== old.position + old.frames) this.fade = this.fadeFrames;
            this.position = current.position + this.cursor;
          }
        }
      } else if (this.active) {
        if (this.eof) { this.active = false; ended = true; }
        else if (this.started && !this.starved) {
          this.starved = true; underrun = true;
          this.tail = this.fadeFrames; this.tailL = this.lastL; this.tailR = this.lastR;
        }
      }
      if (this.tail > 0) {
        const gain = this.tail-- / this.fadeFrames;
        l += this.tailL * gain; r += this.tailR * gain;
      }
      left[i] = this.lastL = Math.max(-1, Math.min(1, l));
      right[i] = this.lastR = Math.max(-1, Math.min(1, r));
    }
    this.reportFrames += left.length;
    if (this.reportFrames >= 512 || underrun || ended) {
      this.reportFrames = 0;
      // No allocations or messages in the per-sample loop.
      if (this.active || ended || underrun) this.report({ underrun, ended });
    }
    return true;
  }
}
registerProcessor('pipe-go-doep-live', LivePCMProcessor);
