const EMPTY = -1;

class BlockMaskMap {
    constructor(initialCapacity = 4096) {
        const cap = 1 << (32 - Math.clz32(Math.max(15, initialCapacity - 1)));
        this._capacity = cap;
        this._mask = cap - 1;
        this._size = 0;
        this.keys = new Int32Array(cap).fill(EMPTY);
        this.lo = new Uint32Array(cap);
        this.hi = new Uint32Array(cap);
    }

    get size() { return this._size; }

    slot(key) {
        const mask = this._mask;
        let i = (Math.imul(key, 0x9E3779B9) >>> 0) & mask;
        while (true) {
            const k = this.keys[i];
            if (k === key || k === EMPTY) return i;
            i = (i + 1) & mask;
        }
    }

    has(key) { return this.keys[this.slot(key)] !== EMPTY; }

    set(key, loVal, hiVal) {
        let s = this.slot(key);
        if (this.keys[s] === EMPTY) {
            this.keys[s] = key;
            this._size++;
            if (this._size > ((this._capacity * 0.7) | 0)) {
                this._grow();
                s = this.slot(key);
            }
        }
        this.lo[s] = loVal;
        this.hi[s] = hiVal;
    }

    removeAt(slot) {
        this._size--;
        const mask = this._mask;
        let i = slot;
        let j = slot;
        while (true) {
            j = (j + 1) & mask;
            if (this.keys[j] === EMPTY) break;
            const k = ((Math.imul(this.keys[j], 0x9E3779B9) >>> 0) & mask);
            if ((i < j) ? (k <= i || k > j) : (k <= i && k > j)) {
                this.keys[i] = this.keys[j];
                this.lo[i] = this.lo[j];
                this.hi[i] = this.hi[j];
                i = j;
            }
        }
        this.keys[i] = EMPTY;
    }

    clear() { this.keys.fill(EMPTY); this._size = 0; }

    releaseStorage() {
        this.keys = new Int32Array(0);
        this.lo = new Uint32Array(0);
        this.hi = new Uint32Array(0);
        this._size = 0;
        this._capacity = 0;
        this._mask = 0;
    }

    clone() {
        const c = new BlockMaskMap(this._capacity);
        c.keys.set(this.keys);
        c.lo.set(this.lo);
        c.hi.set(this.hi);
        c._size = this._size;
        return c;
    }

    _grow() {
        const oldKeys = this.keys;
        const oldLo = this.lo;
        const oldHi = this.hi;
        const oldCap = this._capacity;
        this._capacity *= 2;
        this._mask = this._capacity - 1;
        this.keys = new Int32Array(this._capacity).fill(EMPTY);
        this.lo = new Uint32Array(this._capacity);
        this.hi = new Uint32Array(this._capacity);
        this._size = 0;
        for (let i = 0; i < oldCap; i++) {
            if (oldKeys[i] !== EMPTY) {
                const s = this.slot(oldKeys[i]);
                this.keys[s] = oldKeys[i];
                this.lo[s] = oldLo[i];
                this.hi[s] = oldHi[i];
                this._size++;
            }
        }
    }
}

export { BlockMaskMap };
