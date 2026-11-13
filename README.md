# MURMUR

A hands-first evening with the starlings, for Meta Quest. A lost starling turns up in your room at dusk. You travel to four places where starlings gather, bring its flock home a few hundred at a time, and at nightfall all nine hundred settle around you. Everything is done with your bare hands.

| Gesture | What it does |
|---|---|
| Open palm, held up toward the flock | Calls the flock to your hand |
| Fist | Scatters the flock; over Rome, aimed at the falcon, it drives the falcon off |
| Pinch and draw | Sketch a path in the air; release and the flock flies it |

After the opening, a map of four lights floats within reach: open farmland, the Danish marshes, a seaside pier and the rooftops of Rome. Touch one to go there, in any order. Each place has its own challenge (two rings, a drawn path, sea wind and a drifting ring, a hunting falcon), grows the flock (1, 40, 250, 600, 900) and earns a field note about real starling behaviour.

By default each place replaces your room with a 360 degree photograph, so you are standing in it. A light on the map switches to staying in your own room in passthrough instead, and nightfall always brings you back home. The whole experience is seated, controller-free, and takes about five minutes.

## Mixed reality features
- **Passthrough:** the story starts and ends in your actual room, and you can choose to keep every place there.
- **Hand tracking:** gestures are read from raw WebXR hand joints (fingertip reach, pinch distance, palm direction). No controllers are needed.
- **Plane detection:** gates are kept in front of your real walls, and in Free Flight the flock can come to rest over a real table in view.

## Tech
- [Immersive Web SDK](https://github.com/facebook/immersive-web-sdk) (WebXR, Three.js, ECS)
- A boids simulation with a spatial hash; ~900 birds in a single instanced mesh with flapping done in the vertex shader. Like real starlings, each bird reacts to only about seven neighbours. Your call steers velocities (seek) so the stream flies *through* gates, and each bird aims at its own drifting spot, so a called flock forms a breathing cloud. The bird count adapts if frames get slow.
- Procedural audio from the Web Audio API: the wing-rush swells with the flock's speed.

## Run locally
```bash
npm install
npm run dev      # opens the IWSDK emulator (no headset needed)
npm run build    # static build in dist/
```

## License
MIT. `src/panel.ts` started from the IWSDK starter template (MIT, Meta Platforms).

The 360 degree photographs in `public/worlds` are from [Poly Haven](https://polyhaven.com) (CC0): `evening_field`, `winter_sky`, `the_sky_is_on_fire` and `belvedere`. They stand in for the kind of landscape at each place; only the Rome one was taken at the named location.
