import { viewProjLH, type Mat4Array } from "./math.js";

/** A simple perspective camera. The view-projection matrix is the only thing
 *  that crosses into WASM (16 floats, once per frame). */
export class Camera {
  position: [number, number, number] = [0, 0, -10];
  target: [number, number, number] = [0, 0, 0];
  up: [number, number, number] = [0, 1, 0];
  fovY = 0.8;
  // near/far default to a ~1000-unit scene. Hyperbolic depth means a far/near
  // ratio much above ~2000 destroys precision for anything not near the camera —
  // set these to your scene's real extent.
  near = 0.5;
  far = 1500;
  aspect = 1;

  /** Frame a scene of half-extent `radius` around `target`. Picks near/far that
   *  keep hyperbolic depth precision usable (far/near ≈ 200) while leaving room
   *  for an orbit camera at a few × radius — the F-009 black-screen bug was a
   *  far/near of ~40000. */
  fit(radius: number) {
    this.near = Math.max(0.02, radius * 0.05);
    this.far = radius * 10;
    return this;
  }

  private _vp = new Float32Array(16);

  viewProj(aspect = this.aspect): Mat4Array {
    return viewProjLH(this.position, this.target, this.up, this.fovY, aspect, this.near, this.far, this._vp);
  }
}
