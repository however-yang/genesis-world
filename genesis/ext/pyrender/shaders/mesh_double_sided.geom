#version 330 core
layout (triangles) in;
layout (triangle_strip, max_vertices=6) out;

in vec3 v_frag_position[];
out vec3 frag_position;
#ifdef NORMAL_LOC
in vec3 v_frag_normal[];
out vec3 frag_normal;
#endif
#ifdef HAS_NORMAL_TEX
#ifdef TANGENT_LOC
#ifdef NORMAL_LOC
in mat3 v_tbn[];
out mat3 tbn;
#endif
#endif
#endif
#ifdef TEXCOORD_0_LOC
in vec2 v_uv_0[];
out vec2 uv_0;
#endif
#ifdef TEXCOORD_1_LOC
in vec2 v_uv_1[];
out vec2 uv_1;
#endif
#ifdef COLOR_0_LOC
in vec4 v_color_multiplier[];
// Sampled inside the triangle, as mesh.frag explains.
#ifdef AUX_TARGETS
centroid out vec4 color_multiplier;
#else
out vec4 color_multiplier;
#endif
#endif
#ifdef REST_SPACE
in vec3 v_rest_position[];
in vec3 v_rest_normal[];
in float v_hex_density[];
out vec3 rest_position;
out vec3 rest_normal;
out float hex_density;
#endif

void emit_vertex(int i, bool reversed) {
    gl_Position = gl_in[i].gl_Position;

    frag_position = v_frag_position[i];

#ifdef NORMAL_LOC
    if (reversed) {
        frag_normal = -v_frag_normal[i];
    } else {
        frag_normal = v_frag_normal[i];
    }
#endif

#ifdef HAS_NORMAL_TEX
#ifdef TANGENT_LOC
#ifdef NORMAL_LOC
    if (reversed) {
        tbn = mat3(-v_tbn[i][0], v_tbn[i][1], -v_tbn[i][2]);
    } else {
        tbn = v_tbn[i];
    }
#endif
#endif
#endif

#ifdef TEXCOORD_0_LOC
    uv_0 = v_uv_0[i];
#endif

#ifdef TEXCOORD_1_LOC
    uv_1 = v_uv_1[i];
#endif

#ifdef COLOR_0_LOC
    color_multiplier = v_color_multiplier[i];
#endif

#ifdef REST_SPACE
    // The material keeps its side in rest space: the back face flips only the normal it is lit by.
    rest_position = v_rest_position[i];
    rest_normal = v_rest_normal[i];
    hex_density = v_hex_density[i];
#endif

    EmitVertex();
}

void main() {
    emit_vertex(0, false);
    emit_vertex(1, false);
    emit_vertex(2, false);
    EndPrimitive();

    emit_vertex(0, true);
    emit_vertex(2, true);
    emit_vertex(1, true);
    EndPrimitive();
}
