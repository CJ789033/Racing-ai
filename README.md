# Racing AI 🏎️🧠

A 3D evolution sandbox (in the spirit of "Evolution"-style simulators): **you build a race track, and a
population of neural-network drivers evolves until it finds the fastest lap.**

Runs in any browser and packages as an Android APK via [Capacitor](https://capacitorjs.com).

## How it works

| Piece | What it does | File |
|---|---|---|
| Track builder | Tap to place control points, drag to move; a smooth closed spline is built through them. Warns about corners too tight to drive. | `src/ui/editor.js`, `src/sim/track.js` |
| Car physics | Top-down bicycle model: engine, brakes, drag, grip limit (understeer + tyre scrub if you corner too fast). | `src/sim/car.js` |
| Sensors (inputs) | 9 distance rays to the track edges, speed, position across the track, heading error, and the track's upcoming curvature 15/35/70 m ahead. 15 inputs in total. | `src/sim/car.js` |
| Brain | Feed-forward net, `15 → 12 → 8 → 2` (tanh). Outputs **steering** and **throttle/brake**. | `src/sim/nn.js` |
| Evolution | Genetic algorithm: fitness → tournament selection → two-point crossover → gaussian mutation, with elitism (the best-ever brain always survives) and mutation that ramps up automatically when progress stalls. | `src/sim/evolution.js` |
| Fitness | Cars that don't finish are scored by distance covered. **Every finisher beats every non-finisher**, and among finishers a faster lap scores higher, so once the AI can get round, the only goal left is lap time. | `Car.computeFitness()` |

A car is eliminated when it leaves the track, stops making progress for 3 s, or drives the wrong way.
Each generation ends when all cars are out or the time limit is reached (1.25× the best lap so far).

When you edit the track and restart, the population starts from the best brain so far (transfer
learning), so it usually adapts quickly. Use **AI → Reset AI** to start from scratch.

Progress (track, best brain, history) is saved automatically in local storage.

### Controls

- **Track** – back to the editor. **Pause**, **speed** (1×–25×, MAX = as fast as the device can go)
- **Camera** – Orbit (drag/pinch), Follow the leader, Top-down
- **Sensors** – show the leader's rays. **Brain** – live network activations + progress/lap-time chart
- **AI** – population size, mutation rate/strength, hidden layers, shadows

Car colours: 🟡 leader · 🟣 elite (unchanged from last gen) · 🔵 racing · 🟢 finished · ⚫ out

## Running it

```bash
npm install
npm run dev        # open the printed URL (works on your phone on the same Wi-Fi too)
npm test           # headless check that the AI learns to lap the preset tracks
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
- More track pieces: elevation, banking, different surfaces (grass = slow, not death)
- Multiple laps / flying laps, and checkpoints with split times
- NEAT-style evolving network topology
- Several tracks at once so brains generalise
- Release build signing + Play Store packaging
