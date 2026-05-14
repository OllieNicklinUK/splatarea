export class GameState {
  constructor() {
    this.roundTime = 75;
    this.elapsed = 0;
    this.running = false;
    this.winner = null;
    this.players = [
      { id: "p1", name: "Player 1", color: "#7dd3fc", hp: 100, score: 0, materials: 0, heavyReady: false },
      { id: "p2", name: "Bot", color: "#fb7185", hp: 100, score: 0, materials: 0, heavyReady: false }
    ];
  }

  resetRound() {
    this.elapsed = 0;
    this.running = true;
    this.winner = null;
    for (const player of this.players) {
      player.hp = 100;
      player.materials = 0;
      player.heavyReady = false;
    }
  }

  getPlayer(id) {
    return this.players.find((player) => player.id === id) || null;
  }

  applyDamage(targetId, amount) {
    const player = this.getPlayer(targetId);
    if (!player || !this.running) return false;

    player.hp = Math.max(0, player.hp - amount);
    if (player.hp <= 0) {
      this.running = false;
      this.winner = targetId === "p1" ? "p2" : "p1";
      const winner = this.getPlayer(this.winner);
      if (winner) winner.score += 1;
    }
    return true;
  }

  collectMaterial(playerId, amount = 1) {
    const player = this.getPlayer(playerId);
    if (!player || !this.running) return null;
    player.materials += amount;
    if (player.materials >= 3) {
      player.materials -= 3;
      player.heavyReady = true;
    }
    return { materials: player.materials, heavyReady: player.heavyReady };
  }

  consumeHeavyShot(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !player.heavyReady) return false;
    player.heavyReady = false;
    return true;
  }

  tick(dt) {
    if (!this.running) return;
    this.elapsed += dt;
    if (this.elapsed >= this.roundTime) {
      this.running = false;
      const [p1, p2] = this.players;
      if (p1.hp === p2.hp) {
        this.winner = "draw";
      } else {
        this.winner = p1.hp > p2.hp ? "p1" : "p2";
        const winner = this.getPlayer(this.winner);
        if (winner) winner.score += 1;
      }
    }
  }
}
