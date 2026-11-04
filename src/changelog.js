// "What's new" – every update to the game, newest last in this list.
// Add a new entry at the end (with the next id) whenever something changes;
// returning players get a popup with everything since their last visit.

export const CHANGELOG = [
  { id: 1, date: '2026-11-03', title: 'First version', items: [
    'Build a race track and watch neural-net cars learn to drive it as fast as possible',
    'All the learning happens on your own device – no internet needed',
  ] },
  { id: 2, date: '2026-11-03', title: 'Track pieces', items: [
    'Drag-and-drop track pieces onto a grid',
    'Tap a piece to change it: straight lengths, corner curves, chicanes',
    'Obstacles: swinging hammers and spikes',
    'Smarter population so one lucky car can’t carry the whole field',
  ] },
  { id: 3, date: '2026-11-03', title: 'Website', items: ['The game can be played on a website, so friends can join in'] },
  { id: 4, date: '2026-11-03', title: 'Ramps', items: ['Ramps launch cars into the air – they have to land on the road'] },
  { id: 5, date: '2026-11-03', title: 'Junctions, bridges and tunnels', items: [
    'Junctions (T, Y fork, crossing, roundabout) – the AI picks its own route',
    'Bridges with adjustable height, and tunnels',
    'Speed and slow pads with strength 1–4 that stack',
    'Oil really slides now; ramp steepness, hammer speed and obstacle width options',
  ] },
  { id: 6, date: '2026-11-03', title: 'Bigger grids and bulk editing', items: [
    'Choose the grid size, from Small to Giant',
    'Select several pieces to move or delete them together',
  ] },
  { id: 7, date: '2026-11-03', title: 'Real tunnels', items: [
    'Tunnels go underground, with see-through ground above (can be switched off)',
    'Arched tunnel tubes with lights and entrances',
    'Cars in tunnels get a glowing outline',
  ] },
  { id: 8, date: '2026-11-03', title: 'Laps', items: [
    'Race 1–10 laps (set it on the Start piece)',
    'Stronger, easier-to-see speed and slow pads; drag the obstacle position slider',
  ] },
  { id: 9, date: '2026-11-04', title: 'Smoother driving and brain sizes', items: [
    'No more gaps where curves join',
    'Crash 💥 and stop 💤 markers',
    'New cars start timid, so they really have to learn',
    'Pick the brain size: Very low, Normal, Medium or High',
    'In-game confirm popups (e.g. before clearing data)',
  ] },
  { id: 10, date: '2026-11-04', title: 'Easier rotating', items: ['Rotate pieces by dragging the ⟳ handle or with the mouse wheel'] },
  { id: 11, date: '2026-11-04', title: 'Raised roads and kerbs', items: [
    'Roads sit slightly raised with solid red and white kerbs',
    'Cars tilt on slopes; fixed cars getting stuck on tunnel and bridge ramps',
  ] },
  { id: 12, date: '2026-11-04', title: 'More junctions and obstacles', items: [
    'New junctions: crossroads, 3-way fork, big roundabout',
    'New obstacles: spinner, laser, mud, bumper',
    'Crates break when hit – but they wreck the car',
    'Kerbs on junctions; softer tunnel outline',
  ] },
  { id: 13, date: '2026-11-04', title: 'Move the view', items: ['Zoom and pan in the pieces editor'] },
  { id: 14, date: '2026-11-04', title: 'Paint and copy / paste', items: [
    '🖌️ Paint: drag across the grid to lay road',
    'Copy and paste pieces',
  ] },
  { id: 15, date: '2026-11-04', title: 'Dead ends and better short tunnels', items: [
    'New Dead end piece – a trap for cars that take the wrong turn',
    'Short and corner tunnels go through a hill instead of a steep pit',
  ] },
  { id: 16, date: '2026-11-04', title: 'Tidier tunnel entrances', items: ['Fixed grass and beams sticking out at tunnel entrances'] },
  { id: 17, date: '2026-11-04', title: 'Roads over tunnels', items: ['Roads can now cross over any tunnel, including corner tunnels'] },
  { id: 18, date: '2026-11-04', title: '🚓 Police', items: [
    'Turn on police in AI settings: they evolve to hunt the racers, and only the best police brains are kept',
    'Y fork: choose which way the branch goes',
  ] },
  { id: 19, date: '2026-11-04', title: 'Smarter police', items: [
    'Police learn much faster',
    'Flipping a Y fork keeps it connected the right way round',
  ] },
  { id: 20, date: '2026-11-04', title: 'Track direction fixed', items: [
    'The race direction now follows the road through T pieces, Y forks and roundabouts – no more roads pointing both ways',
    'Cars can’t U-turn or hairpin back up a fork',
  ] },
  { id: 21, date: '2026-11-04', title: 'Police that chase', items: [
    'Police no longer park in the road – they patrol and chase',
    'Only moving police can bust racers; racers bounce off slow ones',
    'Hidden trainee police are tested every generation, so only the very best brains hit the road',
  ] },
  { id: 22, date: '2026-11-04', title: 'Phone-friendly editor', items: [
    'On phones, double-tap an empty square to place a piece – zooming no longer drops pieces by accident',
    '“Don’t show again” on hints, and a button in settings to show them again',
    'Tapping a piece in the parts list only selects it',
    'Drag a piece back onto the parts list to delete it',
  ] },
  { id: 23, date: '2026-11-04', title: 'What’s new', items: ['This list! It pops up when you come back, with everything that changed since your last visit'] },
  { id: 24, date: '2026-11-04', title: '🎓 Tutorial', items: [
    'A guided tour for new players that walks through building a track and watching the AI learn',
    'Replay it any time from ⚙️ AI settings',
  ] },
  { id: 25, date: '2026-11-04', title: '🚓 Police chase map', items: [
    'New preset “Police chase”: lots of junctions and routes to escape – loading it turns police on',
    'Police now wait all over the course, side roads included',
    'At junctions police turn towards the racer they’re hunting, so taking a side road isn’t a free escape',
    'On tracks with junctions some police patrol against the traffic to cut racers off head-on',
  ] },
  { id: 26, date: '2026-11-04', title: '🚓 Police start behind you', items: [
    'Police now line up on a grid behind the start line and set off 2 seconds after the racers – then they hunt you down (they get faster when far behind)',
    'Police join once the racers can finish laps, so the cars learn the track first',
    'T junctions and crossroads have smooth turning lanes instead of a sharp 90° kink',
    'Police chase map: wider road and 3 laps, so there’s time for a proper chase',
  ] },
];

export const LATEST_ID = CHANGELOG[CHANGELOG.length - 1].id;
