#version 330 core
///////////////////////////////////////////////////////////////////////////////
// Structs
///////////////////////////////////////////////////////////////////////////////

struct SpotLight {
    vec3 color;
    float intensity;
    float range;
    vec3 position;
    vec3 direction;
    float light_angle_scale;
    float light_angle_offset;

    #ifdef SPOT_LIGHT_SHADOWS
    sampler2DShadow shadow_map;
    mat4 light_matrix;
    #endif
};

struct DirectionalLight {
    vec3 color;
    float intensity;
    vec3 direction;

    #ifdef DIRECTIONAL_LIGHT_SHADOWS
    sampler2DShadow shadow_map;
    mat4 light_matrix;
    #endif
};

struct PointLight {
    vec3 color;
    float intensity;
    float range;
    vec3 position;

    #ifdef POINT_LIGHT_SHADOWS
    samplerCube shadow_map;
    #endif
};

struct Material {
    vec3 emissive_factor;

#ifdef USE_METALLIC_MATERIAL
    vec4 base_color_factor;
    float metallic_factor;
    float roughness_factor;
#endif

#ifdef USE_GLOSSY_MATERIAL
    vec4 diffuse_factor;
    vec3 specular_factor;
    float glossiness_factor;
#endif

#ifdef HAS_NORMAL_TEX
    sampler2D normal_texture;
#endif
#ifdef HAS_OCCLUSION_TEX
    sampler2D occlusion_texture;
#endif
#ifdef HAS_EMISSIVE_TEX
    sampler2D emissive_texture;
#endif
#ifdef HAS_BASE_COLOR_TEX
    sampler2D base_color_texture;
#endif
#ifdef HAS_METALLIC_ROUGHNESS_TEX
    sampler2D metallic_roughness_texture;
#endif
#ifdef HAS_DIFFUSE_TEX
    sampler2D diffuse_texture;
#endif
#ifdef HAS_SPECULAR_GLOSSINESS_TEX
    sampler2D specular_glossiness;
#endif
};

struct PBRInfo {
    float nl;
    float nv;
    float nh;
    float lh;
    float vh;
    float roughness;
    float metallic;
    vec3 f0;
    vec3 c_diff;
};

///////////////////////////////////////////////////////////////////////////////
// Uniforms
///////////////////////////////////////////////////////////////////////////////
uniform Material material;
uniform PointLight point_lights[MAX_POINT_LIGHTS];
uniform int n_point_lights;
uniform DirectionalLight directional_lights[MAX_DIRECTIONAL_LIGHTS];
uniform int n_directional_lights;
uniform SpotLight spot_lights[MAX_SPOT_LIGHTS];
uniform int n_spot_lights;
uniform vec3 cam_pos;
uniform vec3 ambient_light;
uniform sampler2D floor_tex;
uniform int floor_flag;
uniform vec2 screen_size;

uniform mat4 reflection_mat;

#ifdef USE_IBL
uniform samplerCube diffuse_env;
uniform samplerCube specular_env;
#endif

///////////////////////////////////////////////////////////////////////////////
// Inputs
///////////////////////////////////////////////////////////////////////////////

in vec3 frag_position;
#ifdef NORMAL_LOC
in vec3 frag_normal;
#endif
#ifdef HAS_NORMAL_TEX
#ifdef TANGENT_LOC
#ifdef NORMAL_LOC
in mat3 tbn;
#endif
#endif
#endif
#ifdef TEXCOORD_0_LOC
in vec2 uv_0;
#endif
#ifdef TEXCOORD_1_LOC
in vec2 uv_1;
#endif
#ifdef REST_SPACE
// The material's maps are laid in the rest space of the tissue (a deforming, cut surface has no lasting texture
// coordinates): the vertex's rest position in repeats of the maps, its rest normal, and the density of the hexagons
// that tile the maps, in hexagons per repeat, 0 for maps laid as they are. The mesh carries them as its first two
// texture coordinates and its tangent (rest_attributes in endoscopic_tissue/rendering.py).
in vec3 rest_position;
in vec3 rest_normal;
in float hex_density;
#endif
#ifdef COLOR_0_LOC
#ifdef AUX_TARGETS
// The colour is sampled inside its triangle: with multisampling, a pixel whose centre lies outside a sliver of a
// triangle would extrapolate it far out of its range, below zero included, which the sRGB decoding turns into NaN, and
// the camera's half-float targets keep it.
centroid in vec4 color_multiplier;
#else
in vec4 color_multiplier;
#endif
#endif

///////////////////////////////////////////////////////////////////////////////
// OUTPUTS
///////////////////////////////////////////////////////////////////////////////

#ifdef AUX_TARGETS
// Targets of the endoscope camera (TissueOptics in endoscopic_tissue/rendering.py), in linear light without bounds:
// the diffuse light here, with the distance from the camera; the specular light, with the material's class (its base
// colour's alpha, 1 for metal); the normal, encoded as the normal pass draws it (mesh_normal.frag); and the
// gamma-encoded diffuse albedo.
layout(location = 0) out vec4 frag_color;
layout(location = 1) out vec4 aux_color;
layout(location = 2) out vec4 normal_color;
layout(location = 3) out vec4 albedo_color;
// The fluid over wet tissue pools into a smooth, continuous film over a share of it, the green channel of the
// metallic-roughness map, which tissue leaves unused, or this default: there the film mirrors the lamp. Elsewhere a
// thin film follows the tissue's relief at the material's roughness.
float pooled_share = 0.5;
// Roughness of the pooled film's surface, a free surface of water: optically smooth, its lobe set by the lamp's size
// and by the film's undulations over the pixel.
uniform float pooled_film_roughness = 0.035;
// The lamp is the exit of the light guide around the endoscope's lens, the annulus of fibres of a 10 mm laparoscope
// between these radii in metres, of uniform radiance. A smooth film mirrors it as it is, so that the glints of wet
// tissue are the islands of the film whose normals send the camera's view into the annulus: the film's undulations
// over a few tenths of a millimetre to a few millimetres break them into the irregular flakes of laparoscopic images,
// where a point lamp would leave dots.
uniform float lamp_inner_radius = 0.003;
uniform float lamp_outer_radius = 0.0045;
// The distance of the fragment from the point light being shaded, set per light: its annulus subtends the angles of
// its radii over it. A light other than a point light shades as a point.
float lamp_distance = 1e9;
// GGX alpha that widens the lobe of the thin film following the relief: the lamp's angular radius over 2, set per point
// light, and, squared, the spread of the shading normal over the pixel (specular antialiasing).
float source_alpha = 0.0;
float pixel_alpha2 = 0.0;
// The surface of the film of fluid, which surface tension smooths over the tissue's finest relief: the normal map read
// film_mip_bias mip levels coarser, about a third of a millimetre at the demonstration's working distance, and the
// squared spread of its normal over the pixel.
uniform float film_mip_bias = 2.0;
vec3 film_normal = vec3(0.0, 0.0, 1.0);
float film_alpha2 = 0.0;
#else
out vec4 frag_color;
#endif

///////////////////////////////////////////////////////////////////////////////
// Constants
///////////////////////////////////////////////////////////////////////////////
const float PI = 3.141592653589793;
const float min_roughness = 0.04;

///////////////////////////////////////////////////////////////////////////////
// Utility Functions
///////////////////////////////////////////////////////////////////////////////
vec4 srgb_to_linear(vec4 srgb)
{
#ifndef SRGB_CORRECTED
    vec3 b_less = step(vec3(0.04045), srgb.xyz);
    vec3 lin_out = mix(srgb.xyz / vec3(12.92), pow((srgb.xyz + vec3(0.055)) / vec3(1.055), vec3(2.4)), b_less);
    return vec4(lin_out, srgb.w);
#else
    return srgb;
#endif
}

// Normal computation, the normal map read `mip_bias` levels coarser than the pixel's footprint
vec3 get_normal_biased(float mip_bias)
{
#ifdef HAS_NORMAL_TEX

#ifndef HAS_TANGENTS
    vec3 pos_dx = dFdx(frag_position);
    vec3 pos_dy = dFdy(frag_position);
    vec3 tex_dx = dFdx(vec3(uv_0, 0.0));
    vec3 tex_dy = dFdy(vec3(uv_0, 0.0));
    vec3 t = (tex_dy.t * pos_dx - tex_dx.t * pos_dy) / (tex_dx.s * tex_dy.t - tex_dy.s * tex_dx.t);

#ifdef NORMAL_LOC
    vec3 ng = normalize(frag_normal);
#else
    vec3 ng = cross(pos_dx, pos_dy);
#endif

    t = normalize(t - ng * dot(ng, t));
    vec3 b = normalize(cross(ng, t));
    mat3 tbn_n = mat3(t, b, ng);

#else

    mat3 tbn_n = tbn;

#endif

    vec3 n = texture(material.normal_texture, uv_0, mip_bias).rgb;
    n = normalize(tbn_n * ((2.0 * n - 1.0) * vec3(1.0, 1.0, 1.0)));
    return n;

#else

#ifdef NORMAL_LOC
    return frag_normal;
#else
    return normalize(cam_pos - frag_position);
#endif

#endif
}

vec3 get_normal()
{
    return get_normal_biased(0.0);
}

// Fresnel
vec3 specular_reflection(PBRInfo info)
{
    vec3 res = info.f0 + (1.0 - info.f0) * pow(clamp(1.0 - info.vh, 0.0, 1.0), 5.0);
    return res;
}

// Smith
float geometric_occlusion(PBRInfo info)
{
    float r = info.roughness + 1.0;
    float k = r * r / 8.0;
    float g1 = info.nv / (info.nv * (1.0 - k) + k);
    float g2 = info.nl / (info.nl * (1.0 - k) + k);
    return g1 * g2;
}

float microfacet_distribution(PBRInfo info)
{
    float a = info.roughness * info.roughness;
    float a2 = a * a;
    float nh2 = info.nh * info.nh;

    float denom = (nh2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom);
}

#ifdef AUX_TARGETS
// Two uniform random numbers in [0, 1) for the integer coordinates `cell` (a hash without sine, after Hoskins).
vec2 cell_random(vec2 cell)
{
    vec3 p = fract(vec3(cell.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.xx + p.yz) * p.zy);
}

// Perceptual roughness of a lobe of `roughness` widened by the lamp's size and by `spread2`, the squared spread of its
// normal over the pixel.
float widened_roughness(float roughness, float spread2)
{
    float alpha = roughness * roughness + source_alpha;
    return sqrt(sqrt(alpha * alpha + spread2));
}

// The share of a round two-dimensional Gaussian of standard deviation `spread` that falls in a disc of `radius`, its
// centre `offset` from the disc's. The share at the centre is exact, and the profile tends to the disc's edge blurred
// by the Gaussian when the disc is the wider, and to the Gaussian's density times the disc's area when it is the
// narrower.
float disc_cover(float offset, float radius, float spread)
{
    float ratio2 = radius * radius / (spread * spread);
    float centre = 1.0 - exp(-0.5 * ratio2);
    float edge = 1.0 / (1.0 + exp(-1.702 * (radius - offset) / spread));
    float broad = exp(-offset * offset / (2.0 * spread * spread + radius * radius));
    return centre * mix(broad, edge, smoothstep(1.0, 3.0, sqrt(ratio2)));
}

// The radiance a smooth film of normal `normal` mirrors toward `v` from the annulus of the lamp in direction `l` at
// lamp_distance, which sends the irradiance `radiance` at its centre's distance: the lamp's radiance times the
// Fresnel reflectance of water times the share of the film's lobe of reflected directions, a round Gaussian of
// angular spread sqrt(2) alpha, that falls on the annulus. Over a lobe wider than the annulus this is the point
// light's GGX peak, and over a narrower one the image of the annulus itself.
vec3 mirrored_lamp(vec3 normal, vec3 v, vec3 l, vec3 radiance, float alpha2)
{
    vec3 mirrored = reflect(-v, normal);
    float offset = acos(clamp(dot(mirrored, l), -1.0, 1.0));
    float inner = lamp_inner_radius / lamp_distance;
    float outer = lamp_outer_radius / lamp_distance;
    float spread = sqrt(2.0 * alpha2) + 1e-5;
    // An annulus far narrower than the lobe sends the lobe's density at its offset: the limit of the share over the
    // solid angle, which single precision cannot take for a distant light.
    float share = outer < 0.05 * spread
                  ? exp(-offset * offset / (2.0 * spread * spread)) / (2.0 * PI * spread * spread)
                  : max(disc_cover(offset, outer, spread) - disc_cover(offset, inner, spread), 0.0)
                    / (PI * (outer * outer - inner * inner));
    vec3 fresnel = vec3(0.02) + 0.98 * pow(clamp(1.0 - abs(dot(normal, v)), 0.0, 1.0), 5.0);
    return radiance * fresnel * share;
}
#endif

#ifdef REST_SPACE
// The maps are projected along the three axes of rest space (triplanar mapping), each projection weighted by the
// fourth power of the rest normal's component along its axis, so that a surface takes one projection where it faces an
// axis and blends two or three over a narrow band elsewhere: the texture neither stretches on steep sides nor slides
// as the tissue deforms, since rest positions and rest normals move with the material. Within a projection of a map
// without long structures, the plane is tiled by hexagons, each showing the map shifted at random and turned by a
// quarter turn or mirrored, which suits tissue without a direction and costs no trigonometry, and blended into its
// neighbours by luminance (hex-tiling, after Mikkelsen 2022): the map's repeat no longer shows as a lattice. A map that
// holds vessels is laid as it is, since the blends would break the vessels into dashes. A fragment reads at most three
// hexagons of each projection that carries weight. The blend weights come from the albedo and are shared by the other
// maps. The hexagons draw their random numbers from cell_random, which the camera's targets define. Every map is read
// and blended in one pass over the samples, whose values stay in registers.
uniform float hex_sharpness = 7.0;
uniform float hex_luminance_contrast = 0.6;
uniform float projection_cutoff = 0.06;
// The fragment's maps blended in rest space (rest_space_maps): the albedo, the metallic-roughness map, the shading
// normal and the coarser normal of the film of fluid.
vec4 rest_albedo = vec4(0.0);
vec4 rest_mr = vec4(0.0);
vec3 rest_shading_normal = vec3(0.0, 0.0, 1.0);
vec3 rest_film_normal = vec3(0.0, 0.0, 1.0);

vec2 rest_project(vec3 p, int axis)
{
    return axis == 0 ? p.zy : (axis == 1 ? p.xz : p.xy);
}

// The three vertices of the triangular grid (the centres of the hexagons) around `st` and their barycentric weights.
void hex_grid(vec2 st, out vec3 weights, out vec2 vertex1, out vec2 vertex2, out vec2 vertex3)
{
    st *= 3.4641016;
    vec2 skewed = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
    vec2 base_id = floor(skewed);
    vec3 temp = vec3(fract(skewed), 0.0);
    temp.z = 1.0 - temp.x - temp.y;
    float s = step(0.0, -temp.z);
    float s2 = 2.0 * s - 1.0;
    weights = vec3(-temp.z * s2, s - temp.y * s2, s - temp.x * s2);
    vertex1 = base_id + vec2(s, s);
    vertex2 = base_id + vec2(s, 1.0 - s);
    vertex3 = base_id + vec2(1.0 - s, s);
}

vec2 hex_centre(vec2 vertex)
{
    return vec2(vertex.x + 0.5 * vertex.y, 0.8660254 * vertex.y) / 3.4641016;
}

// One of the eight symmetries of the square, at random for a hexagon: a quarter turn, mirrored or not.
mat2 hex_turn(vec2 vertex)
{
    float pick = floor(8.0 * cell_random(vertex + vec2(17.0, 59.0)).x);
    float quarter = mod(pick, 4.0);
    float cs = quarter == 0.0 ? 1.0 : (quarter == 2.0 ? -1.0 : 0.0);
    float si = quarter == 1.0 ? 1.0 : (quarter == 3.0 ? -1.0 : 0.0);
    float mirror = pick >= 4.0 ? -1.0 : 1.0;
    return mat2(mirror * cs, mirror * si, -si, cs);
}

// The slopes of the relief that the tangent-space normal map holds at `st`, turned back by `turn` into its projection.
vec2 map_slope(vec2 st, vec2 st_dx, vec2 st_dy, mat2 turn)
{
    vec3 encoded = textureGrad(material.normal_texture, st, st_dx, st_dy).rgb * 2.0 - 1.0;
    // The maps hold (-dh/du, dh/dv, 1), normalized, v growing down their rows (relief_normals).
    return transpose(turn) * (vec2(-encoded.x, encoded.y) / max(encoded.z, 0.15));
}

// Read and blend the fragment's maps in rest space: the projections and, in each, the map as it is or three
// hexagons, with their weights, turns and screen derivatives. The derivatives are taken first, in uniform control
// flow. Each sample's slopes are laid along its projection's directions on the surface, world vectors along which u
// and v grow, so that the slopes add up across samples, which blends the relief rather than the normals. The film
// reads its coarser normal from the samples that carry most of their projection's weight.
void rest_space_maps()
{
    vec3 normal = normalize(rest_normal);
    vec3 weights = pow(abs(normal), vec3(4.0));
    weights /= weights.x + weights.y + weights.z;
    weights = max(weights - projection_cutoff, 0.0);
    weights /= weights.x + weights.y + weights.z;
    vec3 p_dx = dFdx(rest_position);
    vec3 p_dy = dFdy(rest_position);
    vec3 pos_dx = dFdx(frag_position);
    vec3 pos_dy = dFdy(frag_position);
    vec3 n_geometric = normalize(frag_normal);
    float film_scale = exp2(film_mip_bias);
    vec3 gradient = vec3(0.0);
    vec3 film_gradient = vec3(0.0);
    float film_weight = 0.0;
    for (int axis = 0; axis < 3; axis++) {
        vec2 st = rest_project(rest_position, axis);
        vec2 st_dx = rest_project(p_dx, axis);
        vec2 st_dy = rest_project(p_dy, axis);
        float weight = weights[axis];
        if (weight <= 0.0) {
            continue;
        }
        // World vectors along u and v on the surface: the screen derivatives of the position solved for those of the
        // map coordinates.
        float det = st_dx.x * st_dy.y - st_dx.y * st_dy.x;
        det = abs(det) > 1e-20 ? det : 1e-20;
        vec3 along_u = (st_dy.y * pos_dx - st_dx.y * pos_dy) / det;
        vec3 along_v = (st_dx.x * pos_dy - st_dy.x * pos_dx) / det;
        along_u -= n_geometric * dot(n_geometric, along_u);
        along_v -= n_geometric * dot(n_geometric, along_v);
        along_u *= inversesqrt(max(dot(along_u, along_u), 1e-30));
        along_v *= inversesqrt(max(dot(along_v, along_v), 1e-30));
        vec2 tiles[3];
        mat2 turns[3];
        vec3 tile_weights;
        if (hex_density <= 0.0) {
            for (int i = 0; i < 3; i++) {
                tiles[i] = st;
                turns[i] = mat2(1.0);
            }
            tile_weights = vec3(1.0, 0.0, 0.0);
        } else {
            // Neighbouring hexagons lie about 0.29 / hex_density repeats apart.
            vec2 grid_st = st * hex_density;
            vec2 vertices[3];
            hex_grid(grid_st, tile_weights, vertices[0], vertices[1], vertices[2]);
            for (int i = 0; i < 3; i++) {
                turns[i] = hex_turn(vertices[i]);
                vec2 centre = hex_centre(vertices[i]);
                tiles[i] = (turns[i] * (grid_st - centre) + centre) / hex_density + cell_random(vertices[i]);
            }
            tile_weights = pow(tile_weights, vec3(hex_sharpness));
        }
        vec4 albedos[3];
        vec3 luminance;
        for (int i = 0; i < 3; i++) {
            albedos[i] = tile_weights[i] > 0.0
                         ? textureGrad(material.base_color_texture, tiles[i], turns[i] * st_dx, turns[i] * st_dy)
                         : vec4(0.0);
            luminance[i] = dot(albedos[i].rgb, vec3(0.299, 0.587, 0.114));
        }
        if (hex_density > 0.0) {
            // The default as a literal: the compiler folds its arithmetic, which a run-time value cannot repeat to
            // the last bit (one level on a few pixels); any other value takes the uniform.
            tile_weights *= hex_luminance_contrast == 0.6 ? mix(vec3(1.0), luminance, 0.6)
                                                          : mix(vec3(1.0), luminance, hex_luminance_contrast);
        }
        tile_weights /= max(tile_weights.x + tile_weights.y + tile_weights.z, 1e-9);
        for (int i = 0; i < 3; i++) {
            float w = weight * tile_weights[i];
            if (w > 1e-3) {
                vec2 tile_dx = turns[i] * st_dx;
                vec2 tile_dy = turns[i] * st_dy;
                rest_albedo += w * albedos[i];
#ifdef HAS_METALLIC_ROUGHNESS_TEX
                rest_mr += w * textureGrad(material.metallic_roughness_texture, tiles[i], tile_dx, tile_dy);
#endif
                vec2 slope = map_slope(tiles[i], tile_dx, tile_dy, turns[i]);
                gradient += w * (slope.x * along_u + slope.y * along_v);
                if (tile_weights[i] > 0.25) {
                    vec2 film_slope = map_slope(tiles[i], film_scale * tile_dx, film_scale * tile_dy, turns[i]);
                    film_gradient += w * (film_slope.x * along_u + film_slope.y * along_v);
                    film_weight += w;
                }
            }
        }
    }
    rest_shading_normal = normalize(n_geometric - gradient);
    rest_film_normal = normalize(n_geometric - film_gradient / max(film_weight, 1e-6));
}
#endif

void compute_brdf_split(vec3 n, vec3 v, vec3 l,
                        float roughness, float metalness,
                        vec3 f0, vec3 c_diff,
                        vec3 radiance, float cavity_ao,
                        out vec3 out_diffuse, out vec3 out_spec)
{
    vec3 h = normalize(l + v);
    float raw_nl = dot(n, l);
    float nl = clamp(raw_nl, 0.001, 1.0);
    float nv = clamp(abs(dot(n, v)), 0.001, 1.0);
    float nh = clamp(dot(n, h), 0.0, 1.0);
    float lh = clamp(dot(l, h), 0.0, 1.0);
    float vh = clamp(dot(v, h), 0.0, 1.0);

    if (metalness < 0.02) {
#ifdef AUX_TARGETS
        // Wet tissue under a clear coat of fluid (water, F0 0.02). Where the fluid pools, its smooth film mirrors the
        // annulus of the lamp (mirrored_lamp), and elsewhere a thin film follows the tissue's relief at the material's
        // roughness: its specular light has a sharp lobe over the pooled film and a broad one over the rest (dual-lobe
        // specular), and is kept apart from the light below, as in EndoDGS. Under the fluid, the tissue's own interface
        // reflects next to nothing (F0 below 0.001 between water and tissue). The light through the coat, in and out,
        // enters the tissue, where TissueOptics scatters it.
        float pooled_alpha = pooled_film_roughness * pooled_film_roughness;
        vec3 pooled_lobe = mirrored_lamp(film_normal, v, l, radiance, pooled_alpha * pooled_alpha + film_alpha2);
        PBRInfo relief_info = PBRInfo(nl, nv, nh, lh, vh, widened_roughness(roughness, pixel_alpha2), 0.0, vec3(0.02),
                                      c_diff);
        vec3 F_wet = specular_reflection(relief_info);
        vec3 relief_lobe = radiance * F_wet * nl * geometric_occlusion(relief_info)
                           * microfacet_distribution(relief_info) / (4.0 * nl * nv + 0.001);
        float wet_occlusion = mix(0.35, 1.0, cavity_ao);
        out_spec = mix(relief_lobe, pooled_lobe, pooled_share) * wet_occlusion;
        out_diffuse = radiance * nl * (1.0 - F_wet) * (1.0 - F_wet) * (c_diff / PI);
        return;
#endif
        // Biological soft tissue: Lambert diffuse + dual-lobe wet clearcoat. The light of an endoscope sits on its
        // lens, so the tissue it shows faces it and has no terminator to soften: the cosine falloff toward the
        // silhouettes is what shapes the tissue, and a wrapped diffuse term would flatten it.

        // Dual-lobe specular: razor-sharp saline tear-film clearcoat (coat_r) + broad moist mucous sheen (body_r).
        float coat_r = clamp(roughness * 0.58, 0.045, 0.13);
        // The fluid film over the tissue spreads the lamp's reflection into a soft whitish veil over the tissue facing
        // the lens, at one roughness whatever the tissue's own.
        float body_r = 0.4;
        PBRInfo coat_info = PBRInfo(nl, nv, nh, lh, vh, coat_r, 0.0, vec3(0.052), c_diff);
        PBRInfo body_info = PBRInfo(nl, nv, nh, lh, vh, body_r, 0.0, vec3(0.040), c_diff);

        vec3 F_coat = specular_reflection(coat_info);
        vec3 F_body = specular_reflection(body_info);
        float denom = 4.0 * nl * nv + 0.001;
        vec3 spec_coat = F_coat * (geometric_occlusion(coat_info) * microfacet_distribution(coat_info) / denom);
        vec3 spec_body = F_body * (geometric_occlusion(body_info) * microfacet_distribution(body_info) / denom);
        float spec_occl = mix(0.35, 1.0, cavity_ao);

        out_diffuse = radiance * (1.0 - 0.50 * F_coat) * (c_diff / PI) * nl;
        out_spec = radiance * nl * (1.85 * spec_coat + 2.0 * spec_body) * spec_occl;
        return;
    }

#ifdef AUX_TARGETS
    roughness = widened_roughness(roughness, pixel_alpha2);
#endif
    PBRInfo info = PBRInfo(nl, nv, nh, lh, vh, roughness, metalness, f0, c_diff);
    vec3 F = specular_reflection(info);
    float G = geometric_occlusion(info);
    float D = microfacet_distribution(info);

    out_diffuse = nl * radiance * (1.0 - F) * c_diff / PI;
    out_spec = nl * radiance * (F * G * D / (4.0 * nl * nv + 0.001));
}

// Percentage-closer filtering over a 3x3 texel neighborhood.
float PCF(sampler2DShadow shadow_map, vec3 coords){
    vec2 texel_size = 1.0 / vec2(textureSize(shadow_map, 0));
    float result = 0.0;
    for(int x=-1; x<=1; x++){
        for(int y=-1; y<=1; y++){
            result += texture(shadow_map, coords + vec3(vec2(x, y) * texel_size, 0.0));
        }
    }
    return result / 9.0;
}

float shadow_calc(mat4 light_matrix, sampler2DShadow shadow_map, float nl)
{
    vec4 proj_coords = vec4(light_matrix * vec4(frag_position.xyz, 1.0));
    vec3 light_coords = proj_coords.xyz / proj_coords.w;
    light_coords = light_coords * 0.5 + 0.5;
    float current_depth = light_coords.z;
    float bias = max(0.001 * (1.0 - nl), 0.0001) / proj_coords.w;
    float compare = (current_depth - bias);
    float shadow = PCF(shadow_map, vec3(light_coords.xy, compare));
    return shadow;
}

vec3 point_PCF_samples[20] = vec3[]
(
   vec3( 1,  1,  1), vec3( 1, -1,  1), vec3(-1, -1,  1), vec3(-1,  1,  1),
   vec3( 1,  1, -1), vec3( 1, -1, -1), vec3(-1, -1, -1), vec3(-1,  1, -1),
   vec3( 1,  1,  0), vec3( 1, -1,  0), vec3(-1, -1,  0), vec3(-1,  1,  0),
   vec3( 1,  0,  1), vec3(-1,  0,  1), vec3( 1,  0, -1), vec3(-1,  0, -1),
   vec3( 0,  1,  1), vec3( 0, -1,  1), vec3( 0, -1, -1), vec3( 0,  1, -1)
);
int point_PCF_n = 20;

float point_PCF(samplerCube shadow_map, vec3 frag_to_light, float bias)
{
    float point_PCF_radius = 40.0 / textureSize(shadow_map, 0)[0];
    float dist = length(frag_to_light);
    float shadow = 0.0;
    for (int i = 0; i < point_PCF_n; i++) {
        float dis_shadow = texture(shadow_map, frag_to_light + point_PCF_samples[i] * point_PCF_radius).r * 25.0;
        shadow += (dis_shadow < 24.5 && dist > dis_shadow + bias) ? 1.0 : 0.0;
    }
    return shadow / point_PCF_n;
}

///////////////////////////////////////////////////////////////////////////////
// MAIN
///////////////////////////////////////////////////////////////////////////////
void main()
{
    vec3 reflected_position = (reflection_mat * vec4(frag_position, 1.0)).xyz;
    if(length(reflected_position - frag_position) > 1e-4 && length(reflected_position-cam_pos)<length(frag_position-cam_pos)) discard;

    vec4 color = vec4(vec3(0.0), 1.0);
///////////////////////////////////////////////////////////////////////////////
// Handle Metallic Materials
///////////////////////////////////////////////////////////////////////////////
#ifdef USE_METALLIC_MATERIAL

#ifdef REST_SPACE
    rest_space_maps();
#endif

    // Compute metallic/roughness factors
    float roughness = material.roughness_factor;
    float metallic = material.metallic_factor;
    float cavity_ao = 1.0;
#ifdef HAS_METALLIC_ROUGHNESS_TEX
#ifdef REST_SPACE
    vec4 mr = rest_mr;
#else
    vec4 mr = texture(material.metallic_roughness_texture, uv_0);
#endif
    roughness = roughness * mr.r;
    metallic = metallic * mr.g;
    cavity_ao = (mr.b > 0.001) ? mr.b : 1.0;
#ifdef AUX_TARGETS
    pooled_share = mr.g;
#endif
#endif
    roughness = clamp(roughness, min_roughness, 1.0);
    metallic = clamp(metallic, 0.0, 1.0);

    // Compute albedo
    vec4 base_color = material.base_color_factor;
#ifdef HAS_BASE_COLOR_TEX
#ifdef REST_SPACE
    base_color = base_color * rest_albedo;
#else
    base_color = base_color * texture(material.base_color_texture, uv_0);
#endif
#endif

#ifdef COLOR_0_LOC
    base_color *= color_multiplier;
#endif

    base_color = srgb_to_linear(base_color);

    if (metallic < 0.02) {
        vec3 crevice_tint = mix(vec3(1.0), vec3(0.94, 0.62, 0.50), 1.0 - cavity_ao);
        base_color.rgb *= crevice_tint * mix(0.62, 1.0, cavity_ao);
    }

    // Compute specular and diffuse colors
    vec3 dialectric_spec = vec3(min_roughness);
    vec3 c_diff = mix(vec3(0.0), base_color.rgb * (1 - min_roughness), 1.0 - metallic);
    vec3 f0 = mix(dialectric_spec, base_color.rgb, metallic);

    // Compute normal
#ifdef REST_SPACE
    vec3 n = rest_shading_normal;
#else
    vec3 n = normalize(get_normal());
#endif
#ifdef AUX_TARGETS
    // Specular antialiasing after Tokuyoshi and Kaplanyan: the normal's change across the pixel widens every lobe by
    // the variance of a pixel-wide filter, bounded.
    vec3 dndx = dFdx(n);
    vec3 dndy = dFdy(n);
    pixel_alpha2 = min(0.5 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
#ifdef REST_SPACE
    film_normal = rest_film_normal;
#else
    film_normal = normalize(get_normal_biased(film_mip_bias));
#endif
    vec3 film_dx = dFdx(film_normal);
    vec3 film_dy = dFdy(film_normal);
    film_alpha2 = min(0.5 * (dot(film_dx, film_dx) + dot(film_dy, film_dy)), 0.18);
#endif

    vec3 diffuse_sum = vec3(0.0);
    vec3 spec_sum = vec3(0.0);

    // Loop over lights
    for (int i = 0; i < n_directional_lights; i++) {
        vec3 direction = directional_lights[i].direction;
        vec3 v = normalize(cam_pos - frag_position);
        vec3 l = normalize(-1.0 * direction);

        float attenuation = directional_lights[i].intensity;
        vec3 radiance = attenuation * directional_lights[i].color;

        vec3 d_res, s_res;
        compute_brdf_split(n, v, l, roughness, metallic, f0, c_diff, radiance, cavity_ao, d_res, s_res);

#ifdef DIRECTIONAL_LIGHT_SHADOWS
        float nl = clamp(dot(n,l), 0.0, 1.0);
        float shadow = shadow_calc(
            directional_lights[i].light_matrix,
            directional_lights[i].shadow_map,
            nl
        );
        d_res *= (1.0 - shadow);
        s_res *= (1.0 - shadow);
#endif
        diffuse_sum += d_res;
        spec_sum += s_res;
    }

    for (int i = 0; i < n_point_lights; i++) {
        vec3 position = point_lights[i].position;
        vec3 v = normalize(cam_pos - frag_position);
        vec3 l = normalize(position - frag_position);

        float dist = length(position - frag_position);
        float attenuation = point_lights[i].intensity / (dist * dist);
        vec3 radiance = attenuation * point_lights[i].color;
#ifdef AUX_TARGETS
        source_alpha = lamp_outer_radius / (2.0 * dist);
        lamp_distance = dist;
#endif

        vec3 d_res, s_res;
        compute_brdf_split(n, v, l, roughness, metallic, f0, c_diff, radiance, cavity_ao, d_res, s_res);

#ifdef POINT_LIGHT_SHADOWS
        float bias = max(0.05 * (1.0 - dot(n, l)), 0.005);
        float shadow = point_PCF(point_lights[i].shadow_map, frag_position - position, bias);
        d_res *= (1.0 - shadow);
        s_res *= (1.0 - shadow);
#endif

        diffuse_sum += d_res;
        spec_sum += s_res;
    }
#ifdef AUX_TARGETS
    source_alpha = 0.0;
    lamp_distance = 1e9;
#endif
    for (int i = 0; i < n_spot_lights; i++) {
        vec3 position = spot_lights[i].position;
        vec3 v = normalize(cam_pos - frag_position);
        vec3 l = normalize(position - frag_position);

        vec3 direction = spot_lights[i].direction;
        float las = spot_lights[i].light_angle_scale;
        float lao = spot_lights[i].light_angle_offset;
        float dist = length(position - frag_position);
        float cd = clamp(dot(direction, -l), 0.0, 1.0);
        float attenuation = clamp(cd * las + lao, 0.0, 1.0);
        attenuation = attenuation * attenuation * spot_lights[i].intensity;
        attenuation = attenuation / (dist * dist);
        vec3 radiance = attenuation * spot_lights[i].color;

        vec3 d_res, s_res;
        compute_brdf_split(n, v, l, roughness, metallic, f0, c_diff, radiance, cavity_ao, d_res, s_res);
#ifdef SPOT_LIGHT_SHADOWS
        float nl = clamp(dot(n,l), 0.0, 1.0);
        float shadow = shadow_calc(
            spot_lights[i].light_matrix,
            spot_lights[i].shadow_map,
            nl
        );
        d_res *= (1.0 - shadow);
        s_res *= (1.0 - shadow);
#endif
        diffuse_sum += d_res;
        spec_sum += s_res;
    }
    // The lamp's inverse-square falloff reaches the camera as it is: the camera's tone curve (EndoscopeCamera) holds
    // the highlights of close tissue.
    diffuse_sum += base_color.xyz * ambient_light;

    color.xyz = diffuse_sum + spec_sum;

    // Apply occlusion
#ifdef HAS_OCCLUSION_TEX
    float ao = texture(material.occlusion_texture, uv_0).r;
    color.xyz *= ao;
#endif

    // Apply emissive map.
    vec3 emissive = material.emissive_factor;
#ifdef HAS_EMISSIVE_TEX
    emissive *= srgb_to_linear(texture(material.emissive_texture, uv_0)).rgb;
#endif
    color.xyz += emissive;

    vec3 floor_color = floor_flag != 0 ? texture(floor_tex, gl_FragCoord.xy/screen_size).rgb : vec3(0.0);

    if (floor_flag != 0 && length(floor_color) > 1e-4) {
        vec3 floor_radiance = pow(floor_color, vec3(2.2));
        vec3 v = normalize(cam_pos - frag_position);
        vec3 l = n * dot(n, v) * 2 - v;

        vec3 h = normalize(l+v);
        float vh = clamp(dot(v, h), 0.0, 1.0);
        f0 = vec3(0.03);
        vec3 reflectance = (f0 + (1.0 - f0) * pow(clamp(1.0 - vh, 0.0, 1.0), 5.0)) * 1.0;
        color.xyz = color.xyz * (1-reflectance) + reflectance * floor_radiance;
    }

#ifdef AUX_TARGETS
    // A material of no class (alpha 1) other than metal takes 0.9.
    aux_color = vec4(spec_sum, metallic > 0.5 ? 1.0 : min(base_color.a, 0.9));
#ifdef NORMAL_LOC
    normal_color = vec4(normalize(frag_normal) * 0.5 + 0.5, 1.0);
#else
    normal_color = vec4(0.5, 0.5, 0.5, 1.0);
#endif
    albedo_color = vec4(pow(c_diff, vec3(1.0 / 2.2)), 1.0);
    frag_color = vec4(color.xyz - spec_sum, length(frag_position - cam_pos));
#else
    if (metallic < 0.02) {
        // Desaturate intense wet clearcoat glints cleanly toward pure white (1, 1, 1).
        float spec_mag = max(spec_sum.x, max(spec_sum.y, spec_sum.z));
        float max_c = max(color.x, max(color.y, color.z));
        float glare_white = clamp(smoothstep(0.20, 0.75, spec_mag) + 0.6 * smoothstep(0.68, 1.15, max_c), 0.0, 1.0);
        color.xyz = mix(color.xyz, vec3(max(max_c, spec_mag * 1.15)), 0.92 * glare_white);
    }
    frag_color = clamp(vec4(pow(color.xyz, vec3(1.0/2.2)), color.a * base_color.a), 0.0, 1.0);
#endif

#else
    // TODO GLOSSY MATERIAL BRDF
#endif
}
