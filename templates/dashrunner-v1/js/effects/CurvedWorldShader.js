/**
 * CurvedWorldShader.js - Vertex displacement for curved horizon effect
 * Makes the world bend downward at distance (like Subway Surfers)
 */

export const CurvedWorldShader = {
    uniforms: {
        uCurvature: { value: 0.008 },
        uDistance: { value: 100.0 }
    },

    vertexShader: `
        uniform float uCurvature;
        uniform float uDistance;
        
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        
        void main() {
            vUv = uv;
            vNormal = normalMatrix * normal;
            
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            
            // Apply curvature based on Z distance
            float z = worldPosition.z;
            float curveAmount = z * z * uCurvature;
            worldPosition.y -= curveAmount;
            
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `,

    fragmentShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        
        void main() {
            // Basic lambert shading
            vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
            float diff = max(dot(vNormal, lightDir), 0.0);
            
            vec3 color = vec3(0.8, 0.6, 0.4);
            color *= 0.3 + diff * 0.7;
            
            gl_FragColor = vec4(color, 1.0);
        }
    `
};

/**
 * Helper function to create curved world material
 */
export function createCurvedMaterial(color, uniforms) {
    return {
        uniforms: {
            ...uniforms,
            uColor: { value: color }
        },
        vertexShader: `
            uniform float uCurvature;
            
            varying vec2 vUv;
            varying vec3 vNormal;
            
            void main() {
                vUv = uv;
                vNormal = normalMatrix * normal;
                
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                
                // Apply curvature
                float z = worldPosition.z;
                worldPosition.y -= z * z * uCurvature;
                
                gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            
            varying vec2 vUv;
            varying vec3 vNormal;
            
            void main() {
                vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
                float diff = max(dot(vNormal, lightDir), 0.0);
                
                vec3 color = uColor * (0.4 + diff * 0.6);
                
                gl_FragColor = vec4(color, 1.0);
            }
        `
    };
}
