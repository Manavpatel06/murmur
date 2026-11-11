# MURMUR

A hands-first mixed reality murmuration for Meta Quest. Sit back, and a flock of starlings fills your real room. You shape it with nothing but your hands.

| Gesture | What it does |
|---|---|
| Open palm, held up toward the flock | Calls the flock to your hand |
| Fist | You become the hawk; the flock scatters |
| Pinch and draw | Sketch a path in the air; release and the flock flies it |

Five short levels (Call, Scatter, Draw, Drift, Hawk) ask you to guide the flock through glowing gates, then Free Flight lets you play. The whole experience is seated, controller-free, and takes about ten minutes.

## Mixed reality features
- **Passthrough:** the flock flies through your actual room.
- **Hand tracking:** gestures are read from raw WebXR hand joints (fingertip reach, pinch distance, palm direction). No controllers are needed.
- **Plane detection:** gates are kept in front of your real walls, and in Free Flight the flock settles over your real table.

## Tech
- [Immersive Web SDK](https://github.com/facebook/immersive-web-sdk) (WebXR, Three.js, ECS)
- A boids simulation with a spatial hash; ~900 birds in a single instanced mesh with flapping done in the vertex shader. The bird count adapts if frames get slow.
- Procedural audio from the Web Audio API: the wing-rush swells with the flock's speed.

## Run locally
```bash
npm install
npm run dev      # opens the IWSDK emulator (no headset needed)
npm run build    # static build in dist/
```

## License
MIT. `src/panel.ts` started from the IWSDK starter template (MIT, Meta Platforms).
