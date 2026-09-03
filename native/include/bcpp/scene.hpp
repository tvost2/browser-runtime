// bcpp/scene.hpp — data-oriented scene: transform propagation + bounding refit
// + frustum culling + render-list build, as one fused linear pass.
//
// Nodes MUST be stored in topological order (parent index < child index) so a
// single forward loop propagates world matrices with no recursion and no
// pointer chasing. This is the "one boundary crossing" kernel: JS fills the
// SoA once, calls evaluate(), reads back a compact visible list.

#pragma once
#include "math.hpp"
#include <vector>
#include <cstdint>

namespace bcpp {

// Culling strategy mirrors Babylon Constants.MESHES_CULLINGSTRATEGY_*
enum class CullStrategy : uint32_t {
    Standard = 0,          // sphere reject, then 8-corner box reject
    BoundingSphereOnly = 1,
};

struct SceneData {
    uint32_t count = 0;

    // hierarchy (topologically sorted)
    std::vector<int32_t> parent;      // -1 = root

    // local TRS
    std::vector<Vec3> localPos;
    std::vector<Quat> localRot;
    std::vector<Vec3> localScale;

    // local-space AABB extents of the mesh geometry
    std::vector<Vec3> localMin;
    std::vector<Vec3> localMax;

    // flags: bit0 enabled, bit1 visible, bit2 alwaysActive(skip frustum)
    std::vector<uint32_t> flags;

    // outputs (sized to count)
    std::vector<Mat4> world;          // world matrix per node
    std::vector<Vec4> worldSphere;    // xyz center, w radius (world space)

    void resize(uint32_t n) {
        count = n;
        parent.assign(n, -1);
        localPos.assign(n, {});
        localRot.assign(n, {0, 0, 0, 1});
        localScale.assign(n, {1, 1, 1});
        localMin.assign(n, {-0.5f, -0.5f, -0.5f});
        localMax.assign(n, {0.5f, 0.5f, 0.5f});
        flags.assign(n, 0b011u);
        world.assign(n, Mat4::identity());
        worldSphere.assign(n, {});
    }
};

struct EvalResult {
    uint32_t visibleCount = 0;
    std::vector<uint32_t> visibleIds;          // indices into SceneData
    std::vector<Mat4> visibleWorld;            // parallel world matrices (GPU-ready)
    uint32_t testedCount = 0;
    uint32_t culledByFlags = 0;
    uint32_t culledByFrustum = 0;
};

class Engine {
public:
    SceneData scene;
    EvalResult result;

    void reserveResult(uint32_t n) {
        result.visibleIds.reserve(n);
        result.visibleWorld.reserve(n);
    }

    // viewProj: Babylon transformMatrix (view * projection), row-major.
    void evaluate(const Mat4& viewProj, CullStrategy strategy = CullStrategy::Standard) {
        const uint32_t n = scene.count;
        result.visibleIds.clear();
        result.visibleWorld.clear();
        result.testedCount = 0;
        result.culledByFlags = 0;
        result.culledByFrustum = 0;

        const Frustum fr = Frustum::fromViewProj(viewProj);

        for (uint32_t i = 0; i < n; ++i) {
            // 1. local matrix (compose is Babylon-exact)
            const Mat4 local = Mat4::compose(scene.localScale[i], scene.localRot[i].normalized(), scene.localPos[i]);

            // 2. world = local * parentWorld   (Babylon: child.multiply(parent))
            const int32_t p = scene.parent[i];
            scene.world[i] = (p < 0) ? local : Mat4::multiply(local, scene.world[p]);

            // 3. world-space bounding sphere from local AABB (transform 8 corners)
            const Vec3 lo = scene.localMin[i], hi = scene.localMax[i];
            Vec3 wmin{1e30f, 1e30f, 1e30f}, wmax{-1e30f, -1e30f, -1e30f};
            for (int c = 0; c < 8; ++c) {
                const Vec3 corner{(c & 1) ? hi.x : lo.x, (c & 2) ? hi.y : lo.y, (c & 4) ? hi.z : lo.z};
                const Vec3 w = scene.world[i].transformCoord(corner);
                wmin = Vec3::min(wmin, w);
                wmax = Vec3::max(wmax, w);
            }
            const Vec3 center = (wmin + wmax) * 0.5f;
            const f32 radius = ((wmax - wmin) * 0.5f).length();
            scene.worldSphere[i] = {center.x, center.y, center.z, radius};

            // 4. flag rejects
            const uint32_t fl = scene.flags[i];
            if ((fl & 0b1u) == 0 || (fl & 0b10u) == 0) { result.culledByFlags++; continue; }
            result.testedCount++;

            // 5. frustum test (skip if alwaysActive)
            if ((fl & 0b100u) == 0) {
                bool inside = true;
                for (int pl = 0; pl < 6; ++pl) {
                    if (fr.planes[pl].dotCoordinate(center) <= -radius) { inside = false; break; }
                }
                if (inside && strategy == CullStrategy::Standard) {
                    inside = boxInFrustum(fr, wmin, wmax);
                }
                if (!inside) { result.culledByFrustum++; continue; }
            }

            result.visibleIds.push_back(i);
            result.visibleWorld.push_back(scene.world[i]);
        }
        result.visibleCount = static_cast<uint32_t>(result.visibleIds.size());
    }

private:
    // Babylon BoundingBox.IsInFrustum: 8 world corners vs 6 planes.
    static bool boxInFrustum(const Frustum& fr, Vec3 mn, Vec3 mx) {
        const Vec3 v[8] = {
            {mn.x, mn.y, mn.z}, {mx.x, mn.y, mn.z}, {mx.x, mx.y, mn.z}, {mn.x, mx.y, mn.z},
            {mn.x, mn.y, mx.z}, {mx.x, mn.y, mx.z}, {mx.x, mx.y, mx.z}, {mn.x, mx.y, mx.z},
        };
        for (int p = 0; p < 6; ++p) {
            bool canReturnFalse = true;
            for (int i = 0; i < 8; ++i) {
                if (fr.planes[p].dotCoordinate(v[i]) >= 0) { canReturnFalse = false; break; }
            }
            if (canReturnFalse) return false;
        }
        return true;
    }
};

} // namespace bcpp
