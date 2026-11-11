// Reads raw WebXR hand joints each frame and turns them into simple gestures.
import { Vector3 } from '@iwsdk/core';

export type Gesture = 'none' | 'open' | 'fist' | 'pinch';

export interface HandState {
  tracked: boolean;
  gesture: Gesture;
  palm: Vector3; // palm centre, world space
  pinchPoint: Vector3; // midpoint between thumb and index tips
  wrist: Vector3;
  reach: number;
  normal: Vector3; // direction the palm faces
  pinchDist: number;
}

const TIP_JOINTS = [
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

function makeState(): HandState {
  return {
    tracked: false,
    gesture: 'none',
    palm: new Vector3(),
    pinchPoint: new Vector3(),
    wrist: new Vector3(),
    reach: 0,
    normal: new Vector3(),
    pinchDist: 1,
  };
}

export class HandReader {
  readonly left = makeState();
  readonly right = makeState();
  private tmpA = new Vector3();
  private tmpB = new Vector3();

  update(frame: XRFrame | undefined | null, ref: XRReferenceSpace | null) {
    this.left.tracked = false;
    this.right.tracked = false;
    if (!frame || !ref) return;
    for (const source of frame.session.inputSources) {
      const hand = source.hand;
      if (!hand || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
      const state = source.handedness === 'left' ? this.left : this.right;
      if (!this.read(frame, ref, hand, state, source.handedness === 'left')) continue;
      state.tracked = true;
    }
  }

  private joint(frame: XRFrame, ref: XRReferenceSpace, hand: XRHand, name: string, out: Vector3) {
    const space = hand.get(name as XRHandJoint);
    if (!space) return false;
    const pose = frame.getJointPose?.(space, ref);
    if (!pose) return false;
    const p = pose.transform.position;
    out.set(p.x, p.y, p.z);
    return true;
  }

  private tmpC = new Vector3();
  private tmpD = new Vector3();

  private read(frame: XRFrame, ref: XRReferenceSpace, hand: XRHand, s: HandState, left: boolean) {
    if (!this.joint(frame, ref, hand, 'wrist', s.wrist)) return false;
    if (!this.joint(frame, ref, hand, 'middle-finger-phalanx-proximal', s.palm)) return false;
    s.palm.lerp(s.wrist, 0.35);
    // Palm normal from the wrist and the index/pinky knuckles; mirrored for the left hand.
    if (
      this.joint(frame, ref, hand, 'index-finger-metacarpal', this.tmpC) &&
      this.joint(frame, ref, hand, 'pinky-finger-metacarpal', this.tmpD)
    ) {
      this.tmpC.sub(s.wrist);
      this.tmpD.sub(s.wrist);
      s.normal.crossVectors(this.tmpC, this.tmpD).normalize();
      if (left) s.normal.negate();
    }

    // Pinch: thumb tip close to index tip.
    const thumb = this.tmpA;
    const index = this.tmpB;
    if (!this.joint(frame, ref, hand, 'thumb-tip', thumb)) return false;
    if (!this.joint(frame, ref, hand, 'index-finger-tip', index)) return false;
    s.pinchPoint.copy(thumb).add(index).multiplyScalar(0.5);
    const pinchDist = thumb.distanceTo(index);

    // Curl: average fingertip distance from the wrist.
    let sum = 0;
    let n = 0;
    for (const name of TIP_JOINTS) {
      if (this.joint(frame, ref, hand, name, this.tmpA)) {
        sum += this.tmpA.distanceTo(s.wrist);
        n++;
      }
    }
    const reach = n ? sum / n : 0.15;
    s.reach = reach;
    s.pinchDist = pinchDist;

    if (pinchDist < 0.025) s.gesture = 'pinch';
    else if (reach < 0.105) s.gesture = 'fist';
    else if (reach > 0.145) s.gesture = 'open';
    else s.gesture = 'none';
    return true;
  }
}
