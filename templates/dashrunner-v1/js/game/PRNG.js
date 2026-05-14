export class PRNG {
    constructor(seed) {
        this.baseSeed = seed || Math.floor(Math.random() * 2147483647);
        this.value = this.baseSeed;
    }

    // Mulberry32 algorithm
    next() {
        let t = this.value += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    // Returns float between min (inclusive) and max (exclusive)
    range(min, max) {
        return min + this.next() * (max - min);
    }

    // Returns integer between min (inclusive) and max (inclusive)
    rangeInt(min, max) {
        return Math.floor(this.range(min, max + 1));
    }
}
