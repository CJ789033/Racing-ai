// The player's own car: same physics, sensors and laps as the AI cars, but driven by
// the keyboard / touch buttons instead of a brain. It never gets eliminated – a crash,
// going off the road or being busted puts it back on the road where it happened.
import { Car } from './car.js';

const STEER_RATE = 5;     // how fast the wheel turns towards full lock (per second)
const RESPAWN_AFTER = 1;  // seconds before a crashed player car is put back on the road

export class PlayerCar extends Car {
  constructor(track) {
    super(null, track);
    this.isPlayer = true;
    this.input = { left: false, right: false, gas: false, brake: false };
    this.bestLap = null;   // best single lap (s)
    this.bestRace = null;  // best full race (all laps)
    this.respawns = 0;
    this.lapClock = 0;     // time in the current lap
    this.raceClock = 0;    // time in the current race
  }

  /** start a fresh race at the start line */
  restart() {
    this.reset();
    // start a few metres behind the line (not inside the AI pack); crossing it doesn't count as a lap
    const tr = this.track; let i = tr.finishIndex, w = 0;
    while (w < 10) { const p = tr.prev ? tr.prev[i] : i; if (p === i) break; i = p; w += tr.step; }
    this.x = tr.cx[i]; this.z = tr.cz[i]; this.seg = i; this.roadH = tr.ch[i];
    this.heading = Math.atan2(tr.dz[i], tr.dx[i]);
    this.awaitCross = true;
    this.lapClock = 0; this.raceClock = 0; this.respawns = 0; this.lastResult = null;
  }

  think() {
    const i = this.input;
    const want = (i.right ? 1 : 0) - (i.left ? 1 : 0);
    const dt = this.dt || 1 / 60;
    // ease the wheel towards the wanted lock (keys are all-or-nothing)
    this.steer += Math.max(-STEER_RATE * dt, Math.min(STEER_RATE * dt, want - this.steer));
    if (!want && Math.abs(this.steer) < 0.05) this.steer = 0;
    this.throttle = i.brake ? -1 : i.gas ? 1 : 0;
  }

  step(dt) {
    if (!this.alive) {
      // put it back on the road after a short pause
      if (this.time - this.diedAt > RESPAWN_AFTER) this.respawn();
      else { this.time += dt; this.lapClock += dt; this.raceClock += dt; return; } // crashing costs time
    }
    const lapsBefore = this.lap;
    super.step(dt);
    this.lapClock += dt; this.raceClock += dt;
    if (this.lap > lapsBefore) {
      const t = this.lapTimes[this.lapTimes.length - 1];
      if (t && (!this.bestLap || t < this.bestLap)) this.bestLap = t;
      this.lapClock = 0;
    }
    if (this.finished && !this.lastResult) {
      this.lastResult = { time: this.raceClock, respawns: this.respawns };
      if (!this.respawns && (!this.bestRace || this.raceClock < this.bestRace)) this.bestRace = this.raceClock;
      this.finishedAt = this.time;
    }
    // after the finish, a new race starts by itself
    if (this.finished && this.time - this.finishedAt > 4) this.restart();
  }

  /** back on the road at the nearest point, pointing the right way, standing still (race progress kept) */
  respawn() {
    const tr = this.track, s = this.seg;
    this.x = tr.cx[s]; this.z = tr.cz[s]; this.roadH = tr.ch[s];
    this.heading = Math.atan2(tr.dz[s], tr.dx[s]);
    this.vx = this.vz = this.speed = this.slip = 0; this.steer = 0;
    this.y = 0; this.vy = 0; this.airborne = false;
    this.alive = true; this.crashed = this.stalled = this.busted = false; this.killedBy = null;
    this.onOil = false; this.inMud = false;
    this.respawns++;
  }

  // the player is never removed for stopping or for slow progress – only lap counting applies
  checkEnd() {
    const tr = this.track;
    if (!this.finished && !this.awaitCross && this.lapMax > tr.lapLength * 0.5 && tr.lapLength - this.progress < 1.5) {
      this.lap++;
      this.lapTimes.push(this.time - this.lapStart);
      this.lapStart = this.time;
      this.lapMax = 0;
      this.awaitCross = true;
      this.maxProgress = this.lap * tr.lapLength;
      this.lastProgressTime = this.time;
      if (this.lap >= tr.laps) { this.finished = true; this.lapTime = this.time; }
    }
  }

  // reversing over the start line just puts you back on the road instead of ending your run
  get racing() { return this.alive && !this.finished; }
}
