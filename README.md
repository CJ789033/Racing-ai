# Racing AI 🏎️🧠

A 3D evolution sandbox (in the spirit of "Evolution"-style simulators): **you build a race track, and a
population of neural-network drivers evolves until it finds the fastest lap.**

Runs in any browser and packages as an Android APK via [Capacitor](https://capacitorjs.com).

## How it works

| Piece | What it does | File |
|---|---|---|
| Track builder – 🧩 Pieces | Palette tabs **Road** (Start, Straight, Corner, Chicane, Bridge, Tunnel), **Junctions** (Crossing, T junction, Y fork, Roundabout) and **Obstacles**. Drag onto a 12×9 grid (30 m cells). **Tap a piece to edit it**: straight length 30–120 m, corner curve (r = 15/45/75 m), chicane wiggle, tunnel on/off, bridge length & height. Tap again to rotate, drag to move, drag off the grid to remove. Roads may run under a bridge's middle cells (tap the cell twice to pick the lower piece). **Grid** size from Small 8×6 to Giant 26×19 (the layout stays centred). **⬚ Select** mode: drag a box or tap pieces to select several, then drag one to move them all, nudge with the arrow buttons/keys, or delete them. | `src/ui/tileEditor.js`, `src/sim/tiles.js` |
| Road network | A layout is a network, not just a loop: junction pieces let cars choose their route. For every point the game knows the shortest distance still to drive to the finish; lap progress = lap length − that distance, so it works on any route and the AI is free to discover the fastest one. Bridges add an upper level; tunnels dip 7 m underground (sloping down/up where they open to the surface) under see-through ground, and cars inside get a glowing outline visible from anywhere. Roads can cross over the middle of a tunnel that's 3+ cells long. | `src/sim/track.js` |
| Obstacles | 🔨 **Hammer** (fatal; slow/normal/fast swing), 🔺 **Spikes** (fatal; narrow…full width), 📦 **Crates** (solid), 🛢️ **Oil** (cars slide and spin), ⤴️ **Ramp** (low/normal/steep, narrow…full width; no steering in the air, land on the road!), ⏩ **Speed pad** / 🐢 **Slow pad** (strength 1–4: each pass moves the car's speed level up/down by that much, capped at ±4; each level up = +25 % top speed & power, each level down = −18 %, plus an instant kick/brake on the pad; boosted cars show an exhaust flame; reset every generation). Lane and position are adjustable. | `src/sim/obstacles.js` |
| Track builder – ✏️ Freehand | Tap to place control points, drag to move; a smooth closed spline is built through them. Warns about corners too tight to drive. | `src/ui/editor.js`, `src/sim/track.js` |
| Car physics | Top-down bicycle model with a separate velocity vector: engine, brakes, drag, grip limit (understeer), sideways sliding when grip is low (oil). Cars that stop for 2 s are removed (and score lower than crashing); finished cars drive on for a victory lap. | `src/sim/car.js` |
| Sensors (inputs) | 9 distance rays to the road edge (a top-down map of the road surface, per height level) and to hammers/spikes/crates, speed, position across the road, the direction of the road 10/25/45/70 m ahead along the best route, the current speed level and how much the car is sliding. 17 inputs. | `src/sim/car.js` |
| Brain | Feed-forward net, `17 → 12 → 8 → 2` (tanh). Outputs **steering** and **throttle/brake**. | `src/sim/nn.js` |
| Evolution | Genetic algorithm: fitness → tournament selection → (sometimes) crossover → gaussian mutation. The top 10% survive unchanged; ~60% of children get only tiny "fine-tune" mutations, so most of the field drives as well as the leaders instead of one smart car and 49 wrecks; the rest explore, more strongly while nobody can finish yet or progress stalls. | `src/sim/evolution.js` |
| Laps | Tap the Start piece to choose 1–10 laps (freehand tracks: Laps menu). The race time over all laps is what the AI optimises; the HUD shows the leader's lap. |
| Fitness | Cars that don't finish are scored by distance covered. **Every finisher beats every non-finisher**, and among finishers a faster lap scores higher, so once the AI can get round, the only goal left is lap time. | `Car.computeFitness()` |

A car is eliminated when it leaves the track, stops making progress for 3 s, or drives the wrong way.
Each generation ends when all cars are out or the time limit is reached (1.25× the best lap so far).

When you edit the track and restart, the population starts from the best brain so far (transfer
learning), so it usually adapts quickly. Use **AI → Reset AI** to start from scratch.

### Everything runs locally

All learning happens **on the device**: the physics, the neural networks and the genetic algorithm are
plain JavaScript running inside the app. There is no server, no cloud training and no network access
(the Android app does not even request the INTERNET permission; three.js is bundled into the app). The track, best brain and history are
saved automatically in the device's local storage, so training continues where it left off after
closing the app.

### Controls

- **Track** – back to the editor. **Pause**, **speed** (1×–25×, MAX = as fast as the device can go)
- **Camera** – Orbit (drag/pinch), Follow the leader, Top-down
- **Sensors** – show the leader's rays. **Brain** – live network activations + progress/lap-time chart
- **AI** – population size, mutation rate/strength, brain size (Very low / Normal / Medium / High), road-ahead sense on/off, shadows, see-through tunnels

Car colours: 🟡 leader · 🟣 elite (unchanged from last gen) · 🔵 racing · 🟢 finished · ⚫ out

## Running it

```bash
npm install
npm run dev        # open the printed URL (works on your phone on the same Wi-Fi too)
npm test           # headless check that the AI learns to lap every preset track (freehand + pieces)
```

## Getting the APK

**From GitHub (no Android setup needed):** every push runs the *Build Android APK* workflow.
Open the repo's **Actions** tab → latest run → download the `racing-ai-debug-apk` artifact, unzip it
and install `app-debug.apk` on your phone (allow "install unknown apps").

**Locally** (needs Android Studio / Android SDK + JDK 21):

```bash
npm run android:sync          # build web app and copy it into android/
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Or `npx cap open android` to open the project in Android Studio and run it on a device.

## Ideas for next steps

- Ghost replay of the best lap, and a "race the AI yourself" mode
- More pieces/obstacles: crossovers/bridges, jumps, moving walls, boost pads, elevation, banking, grass that slows instead of kills
- Multiple laps / flying laps, and checkpoints with split times
- NEAT-style evolving network topology
- Several tracks at once so brains generalise
- Release build signing + Play Store packaging
