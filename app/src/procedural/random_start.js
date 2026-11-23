// Random start (the 'Ribbon start: random' setting): from the generated start, a random place in the noise sequence
// and 10-40 s of the ribbon physics before the first frame (up to ~110 ms on a desktop). A new seed alone changes the
// motion only slowly (0.33 rms after a minute) and not the first frame; with the run, openings differ by 0.27-0.43
// from each other and from the fixed one, still full length (5.7-6.0). sim: a LinesSim already at that start, with
// its preset parameters set.
export function randomStart(sim, rand = Math.random) {
  sim.rng = Math.floor(rand() * 2 ** 31);
  const steps = Math.round((10 + 30 * rand()) * 60);
  for (let k = 0; k < steps; k++) sim.update(1 / 60);
}
