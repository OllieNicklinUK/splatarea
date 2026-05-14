/**
 * VignetteShader.js - Post-processing vignette effect
 * Subtle edge darkening without circular clipping
 */

export const VignetteShader = {
    uniforms: {
        tDiffuse: { value: null },
        offset: { value: 1.5 },
        darkness: { value: 0.4 }
    },

    vertexShader: `
        varying vec2 vUv;
        
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float offset;
        uniform float darkness;
        
        varying vec2 vUv;
        
        void main() {
            vec4 texel = texture2D(tDiffuse, vUv);
            
            // Subtle rectangular vignette (less clipping)
            vec2 uv = vUv;
            float vignetteX = smoothstep(0.0, 0.3, uv.x) * smoothstep(1.0, 0.7, uv.x);
            float vignetteY = smoothstep(0.0, 0.3, uv.y) * smoothstep(1.0, 0.7, uv.y);
            float vignette = vignetteX * vignetteY;
            vignette = pow(vignette, darkness * 0.5);
            
            // Apply subtle darkening at edges only
            vec3 color = texel.rgb * (0.7 + vignette * 0.3);
            
            gl_FragColor = vec4(color, texel.a);
        }
    `
};
