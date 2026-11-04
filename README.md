# Racing AI 🏎️🧠

A 3D evolution sandbox (in the spirit of "Evolution"-style simulators): **you build a race track, and a
population of neural-network drivers evolves until it finds the fastest lap.**

Runs in any browser and packages as an Android APK via [Capacitor](https://capacitorjs.com).

## How it works

| Piece | What it does | File |
|---|---|---|
| Track builder – 🧩 Pieces | Palette tabs **Road** (Start, Straight, Corner, Chicane, Bridge, Tunnel, Dead end), **Junctions** (Crossing, Crossroads, T junction, Y fork, 3-way fork, Roundabout, Big roundabout) and **Obstacles**. Drag onto a 12×9 grid (30 m cells). **Tap a piece to edit it**: straight length 30–120 m, corner curve (r = 15/45/75 m), chicane wiggle, tunnel on/off, bridge length & height, Y fork branch side (Right/Left). Tap again to rotate, drag to move, drag off the grid to remove. Roads may run under a bridge's middle cells (tap the cell twice to pick the lower piece). **Grid** size from Small 8×6 to Giant 26×19 (the layout stays centred). **⬚ Select** mode: drag a box or tap pieces to select several, then drag one to move them all, nudge with the arrow buttons/keys, delete, copy or paste them (also Ctrl/⌘+C / V). **🖌️ Paint** mode: drag across the grid to lay a connected road (straights and corners chosen automatically – it joins onto the Start or another road end), or stamp other pieces. Zoom (wheel / pinch / ＋－⤢) and pan (drag empty grass). | `src/ui/tileEditor.js`, `src/sim/tiles.js` |
| Road network | A layout is a network, not just a loop: junction pieces let cars choose their route. Traffic is one-way: at a junction a car can carry on into any road that doesn't need a U-turn or a hairpin (more than 115°) – so a Y fork splits or merges, a T lets you turn either way – and each road gets the one direction that traffic from the start line uses. For every point the game knows the distance still to drive to the finish along legal moves; lap progress = lap length − that distance, so it works on any route and the AI is free to discover the fastest one. Bridges add an upper level; long tunnels (90 m+) dip 7 m underground (sloping down/up where they open to the surface) under see-through ground, and cars inside get a glowing outline visible from anywhere. Roads can cross over any tunnel – straight or corner – as long as the crossing isn't right at an open entrance (the tunnel dives deep under every crossing). | `src/sim/track.js` |
| Obstacles | 🔨 **Hammer** (fatal; slow/normal/fast swing), 🔺 **Spikes** (fatal; narrow…full width), 📦 **Crates** (the first car to hit them is wrecked and smashes them – later cars drive through; rebuilt each generation), 🌀 **Spinner** (rotating bar, fatal), ⚡ **Laser gate** (fatal while on), 🟫 **Mud** (heavy drag), 🔴 **Bumper** (bounces cars sideways), 🛢️ **Oil** (cars slide and spin), ⤴️ **Ramp** (low/normal/steep, narrow…full width; no steering in the air, land on the road!), ⏩ **Speed pad** / 🐢 **Slow pad** (strength 1–4: each pass moves the car's speed level up/down by that much, capped at ±4; each level up = +25 % top speed & power, each level down = −18 %, plus an instant kick/brake on the pad; boosted cars show an exhaust flame; reset every generation). Lane and position are adjustable. | `src/sim/obstacles.js` |
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

### 🚓 Police (co-evolution)
Turn on police in **AI** settings. Police never park (once moving they keep at least ~43 km/h) and bounce off barriers instead of crashing out. A built-in instinct keeps them on the road; their own neural nets evolve the *tactics*: which lane to take, how hard to drive, and when to stop following the road and chase the nearest racer in front of them. Only a cop moving at 30 km/h+ can bust a racer 🚨 – a racer that hits a crawling cop just bounces off. Every generation a hidden squad of trainee cops drives the same track (they score "would-have-busted" catches but don't touch the racers); cops and trainees are ranked together and only the very best brains become the next real police, while all new trainees are mutants of the top two. Racers have a police radar (how close the nearest police car is in each of six 60° zones around them, plus how fast the nearest one is closing in) and their distance sensors see police cars, so both sides keep having to adapt – an arms race. Police line up on a grid behind the start line and set off 3 s after the racers; they're 10 % faster close up and up to 40 % faster when far behind their target (catch-up). After a bust a cop stops for 4 s to make the arrest, so one car can't plough through the whole pack, and at junctions they turn towards the racer they're hunting. They only join once the racers can finish reliably (a generation where 10 % of the cars, at least 5, finish), so the cars learn the track first. Then the number on duty adapts: a third start, one more comes on duty after each generation where enough racers still finish, one goes off duty after 3 generations with no finishers. While police are off the track the racers' radar weights are held at zero, so they can't drift into nonsense that takes over the steering the moment police appear. The **Police chase** preset (3 laps, wide road, lots of escape routes) is built for this and switches police on when loaded. Code: `src/sim/police.js`.

### 🎓 Tutorial
New players get a guided tour (`src/ui/tutorial.js`, steps in `src/main.js`): each step spot-lights one part of the screen – parts, grid, tools, presets, Start evolution, then the race stats, speed, brain, AI settings and the Track button – with Back / Next / Skip (keyboard: ← → Enter Esc). Phones get touch wording. Replay it from **⚙️ AI settings → 🎓 Replay tutorial**.

### 🔗 Track codes
**🔗 Code** in the track builder turns the current track into one line of text (`RAI1.` = compressed, `RAI0.` = plain) and loads a pasted one. The developer menu report includes the code too, so a bug report carries the exact layout. Code: `src/ui/trackCode.js`.

### 🎲 Repeatable runs
All simulation randomness comes from one seedable generator (`src/sim/rng.js`). With **Repeatable runs** on (default, seed 1) the same track + settings + seed always plays out exactly the same – including the police – so a run can be reproduced from its seed; **🎲 New seed** picks another. The random state is saved with the game, so a saved run carries on exactly. Switching tracks still starts from the best brain so far; **Reset AI** starts the seed's run from scratch.

### ⚠️ Crash alert
If the game hits a script error, a banner offers to copy the debug report.

### 🛠️ Developer menu
Hidden: press **↑ ↑ ↓ ← →** (or swipe up, up, down, left, right on a touch screen). Shows the build (commit + build time, so you can tell whether the site has updated), device / GPU / FPS / simulation speed, editor and track diagnostics (roads with no way through or pointing both ways), the AI (generation, settings, why cars went out last generation), the leader's every brain input and output, each police car's state, local storage and captured script errors. It also lists every racer (state, progress, speed, lap), the time per simulation step, and the exact track definition (JSON) so a reported track can be loaded and reproduced. **[copy]** copies it all as text to paste into a bug report.

Once the menu has been opened in a tab, **F1–F10** toggle visual debugging overlays (drawn on top of everything, through tunnels and bridges):
- **F1** key help with what's on
- **F2** movement – each car's heading (white), velocity (cyan racers / blue police) and sideways slide (orange)
- **F3** police – line from each cop to its target (red), its steering aim (yellow +), arrest ring, numbered cops (match the menu), racer → nearest police (orange) and the leader's 70 m radar range
- **F4** track – route arrows coloured by distance to the finish, junction branches (magenta), roads with no way through (grey), start / finish, police grid spots, tunnels
- **F5** sensors – every racer's distance rays (red = close) and the leader's road-ahead points
- **F6** hidden – the trainee police and obstacle hit areas
- **F7** crash map – a cross where every racer went out this and last generation, coloured by reason (off road red, busted blue, stopped grey, wrong way yellow, obstacle magenta); the menu groups them by reason and position along the lap
- **F8** follow a car – cycles leader → racer #1…#n → police 1…n (Shift+F8 back); the camera, sensors, brain panel and the report's car section follow it
- **F9** slow motion (¼ speed)
- **F10** step – pauses, then advances exactly one physics step (1/60 s) per press

For automated tests: `window.__dev.unlock()`, `__dev.key('F3')`, `__dev.report()`. Code: `src/ui/devMenu.js`, `src/render/debugViz.js`.

### 📝 What's new
`src/changelog.js` lists every update in plain language. Returning players get a popup with everything added since their last visit (remembered per device); the 📝 buttons (editor and race toolbar) open it any time and show a dot when there's something unseen. **Add an entry with the next id whenever the game changes.**

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
- **AI** – population size, mutation rate/strength, brain size (Very low / Normal / Medium / High), road-ahead sense on/off, 🚓 police (Off / Few / Some / Many), shadows, see-through tunnels

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
