// bcpp/math.hpp — math primitives, bit-for-bit aligned with Babylon.js
// conventions so equivalence tests can compare numerically.
//
// Conventions (verified against @babylonjs/core v7.54, math.vector.pure.ts):
//   * Matrix is row-major, stored m[0..15], row r = m[4r .. 4r+3].
//   * Vectors are ROW vectors: v' = v * M.
//   * Translation lives in m[12], m[13], m[14].
//   * a.multiply(b) computes a*b with rows(a) . cols(b)  (MultiplyMatricesToArray).
//   * ComposeToRef / FromQuaternionToRef reproduced exactly (same op order).
//
// All types are POD, trivially copyable, no virtuals — safe to memcpy into
// WASM linear memory and to view from JS as Float32Array.

#pragma once
#include <cstdint>
#include <cmath>
#include <array>

namespace bcpp {

using f32 = float;

struct Vec3 {
    f32 x{0}, y{0}, z{0};
    constexpr Vec3() = default;
    constexpr Vec3(f32 x_, f32 y_, f32 z_) : x(x_), y(y_), z(z_) {}
    friend constexpr Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
    friend constexpr Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
    friend constexpr Vec3 operator*(Vec3 a, f32 s) { return {a.x * s, a.y * s, a.z * s}; }
    static constexpr f32 dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    static constexpr Vec3 min(Vec3 a, Vec3 b) {
        return {a.x < b.x ? a.x : b.x, a.y < b.y ? a.y : b.y, a.z < b.z ? a.z : b.z};
    }
    static constexpr Vec3 max(Vec3 a, Vec3 b) {
        return {a.x > b.x ? a.x : b.x, a.y > b.y ? a.y : b.y, a.z > b.z ? a.z : b.z};
    }
    f32 length() const { return std::sqrt(x * x + y * y + z * z); }
};

struct Vec4 {
    f32 x{0}, y{0}, z{0}, w{0};
};

// Quaternion (x,y,z,w) — Babylon order.
struct Quat {
    f32 x{0}, y{0}, z{0}, w{1};
    f32 length() const { return std::sqrt(x * x + y * y + z * z + w * w); }
    Quat normalized() const {
        f32 l = length();
        if (l == 0) return {0, 0, 0, 1};
        f32 inv = 1.0f / l;
        return {x * inv, y * inv, z * inv, w * inv};
    }
    // Babylon Quaternion.RotationYawPitchRollToRef(yaw=y, pitch=x, roll=z)
    static Quat fromEulerYXZ(f32 pitchX, f32 yawY, f32 rollZ) {
        const f32 hr = rollZ * 0.5f, hp = pitchX * 0.5f, hy = yawY * 0.5f;
        const f32 sr = std::sin(hr), cr = std::cos(hr);
        const f32 sp = std::sin(hp), cp = std::cos(hp);
        const f32 sy = std::sin(hy), cy = std::cos(hy);
        return {
            cy * sp * cr + sy * cp * sr,
            sy * cp * cr - cy * sp * sr,
            cy * cp * sr - sy * sp * cr,
            cy * cp * cr + sy * sp * sr,
        };
    }
};

// Row-major 4x4, Babylon layout.
struct Mat4 {
    std::array<f32, 16> m{{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};

    static Mat4 identity() { return Mat4{}; }

    // result = a * b   (exactly Babylon MultiplyMatricesToArray)
    static Mat4 multiply(const Mat4& a, const Mat4& b) {
        const auto& t = a.m;
        const auto& o = b.m;
        Mat4 r;
        auto& d = r.m;
        d[0]  = t[0] * o[0] + t[1] * o[4] + t[2] * o[8]  + t[3] * o[12];
        d[1]  = t[0] * o[1] + t[1] * o[5] + t[2] * o[9]  + t[3] * o[13];
        d[2]  = t[0] * o[2] + t[1] * o[6] + t[2] * o[10] + t[3] * o[14];
        d[3]  = t[0] * o[3] + t[1] * o[7] + t[2] * o[11] + t[3] * o[15];
        d[4]  = t[4] * o[0] + t[5] * o[4] + t[6] * o[8]  + t[7] * o[12];
        d[5]  = t[4] * o[1] + t[5] * o[5] + t[6] * o[9]  + t[7] * o[13];
        d[6]  = t[4] * o[2] + t[5] * o[6] + t[6] * o[10] + t[7] * o[14];
        d[7]  = t[4] * o[3] + t[5] * o[7] + t[6] * o[11] + t[7] * o[15];
        d[8]  = t[8] * o[0] + t[9] * o[4] + t[10] * o[8]  + t[11] * o[12];
        d[9]  = t[8] * o[1] + t[9] * o[5] + t[10] * o[9]  + t[11] * o[13];
        d[10] = t[8] * o[2] + t[9] * o[6] + t[10] * o[10] + t[11] * o[14];
        d[11] = t[8] * o[3] + t[9] * o[7] + t[10] * o[11] + t[11] * o[15];
        d[12] = t[12] * o[0] + t[13] * o[4] + t[14] * o[8]  + t[15] * o[12];
        d[13] = t[12] * o[1] + t[13] * o[5] + t[14] * o[9]  + t[15] * o[13];
        d[14] = t[12] * o[2] + t[13] * o[6] + t[14] * o[10] + t[15] * o[14];
        d[15] = t[12] * o[3] + t[13] * o[7] + t[14] * o[11] + t[15] * o[15];
        return r;
    }

    // Babylon Matrix.ComposeToRef(scale, rotation, translation)
    static Mat4 compose(Vec3 scale, Quat q, Vec3 t) {
        Mat4 r;
        auto& m = r.m;
        const f32 x = q.x, y = q.y, z = q.z, w = q.w;
        const f32 x2 = x + x, y2 = y + y, z2 = z + z;
        const f32 xx = x * x2, xy = x * y2, xz = x * z2;
        const f32 yy = y * y2, yz = y * z2, zz = z * z2;
        const f32 wx = w * x2, wy = w * y2, wz = w * z2;
        const f32 sx = scale.x, sy = scale.y, sz = scale.z;
        m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx;       m[2] = (xz - wy) * sx;       m[3] = 0;
        m[4] = (xy - wz) * sy;       m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy;       m[7] = 0;
        m[8] = (xz + wy) * sz;       m[9] = (yz - wx) * sz;       m[10] = (1 - (xx + yy)) * sz; m[11] = 0;
        m[12] = t.x; m[13] = t.y; m[14] = t.z; m[15] = 1;
        return r;
    }

    // Babylon Vector3.TransformCoordinatesFromFloatsToRef (perspective divide)
    Vec3 transformCoord(Vec3 v) const {
        const auto& q = m;
        const f32 rx = v.x * q[0] + v.y * q[4] + v.z * q[8] + q[12];
        const f32 ry = v.x * q[1] + v.y * q[5] + v.z * q[9] + q[13];
        const f32 rz = v.x * q[2] + v.y * q[6] + v.z * q[10] + q[14];
        const f32 rw = 1.0f / (v.x * q[3] + v.y * q[7] + v.z * q[11] + q[15]);
        return {rx * rw, ry * rw, rz * rw};
    }
};

// Plane in Babylon form: normal + d, point classified by dot(normal,p) + d.
struct Plane {
    Vec3 normal{};
    f32 d{0};
    void normalize() {
        const f32 mag = normal.length();
        f32 inv = (mag == 0.0f) ? 0.0f : 1.0f / mag;
        // Babylon divides by magnitude (not guarding zero); match its NaN/inf
        // behavior only when mag != 0. Guarded here to keep tests deterministic.
        normal = normal * inv;
        d *= inv;
    }
    f32 dotCoordinate(Vec3 p) const { return Vec3::dot(normal, p) + d; }
};

// Babylon Frustum.GetPlanesToRef(transform) — order: near,far,left,right,top,bottom
struct Frustum {
    Plane planes[6];
    static Frustum fromViewProj(const Mat4& t) {
        const auto& m = t.m;
        Frustum f;
        auto set = [](Plane& p, f32 nx, f32 ny, f32 nz, f32 dd) { p.normal = {nx, ny, nz}; p.d = dd; p.normalize(); };
        set(f.planes[0], m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]); // near
        set(f.planes[1], m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); // far
        set(f.planes[2], m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);  // left
        set(f.planes[3], m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);  // right
        set(f.planes[4], m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);  // top
        set(f.planes[5], m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);  // bottom
        return f;
    }
};

} // namespace bcpp
