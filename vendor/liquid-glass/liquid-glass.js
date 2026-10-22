/* @vibe/liquid-glass v0.1.0 — MIT. Reconstructed math; see PROVENANCE.json. */
// core/recovered-optics.js
const m3=(()=>{
/**
 * A bounded WebGL adaptation of decoded QuartzCore AIR instructions.
 * Evidence: research/deep/air-analysis/module-064.ll and module-073.ll.
 *
 * The square-root envelope, LOD mapping and seven-tap spectral weights were
 * recovered from instructions. This is only the inner sampling path: outer
 * refraction, edge bleed, fill/highlights, color matrices, HDR, native alpha
 * handling and material-dependent uniform selection are not ported here.
 * Native displacement matrices and independent aberration direction/height/
 * offset are also not exposed by this deliberately small adapter interface.
 * No defaults below claim to be native per-control parameter values.
 */

/**
 * Insert after the caller's sampler2D u_background and vec2 u_cssSize uniforms.
 * Requires GLSL ES 3.00 and a complete mipmapped background texture.
 * Coordinates, distances, displacement amounts, heights and blur radius use
 * CSS pixels. The supplied normal must be a unit vector in that same space.
 * The background is treated as opaque SDR; this helper returns straight RGB.
 */
const RECOVERED_OPTICS_GLSL = `
float recoveredRefractionEnvelope(float signedDistance, float amount, float height) {
  // module-064.ll:405-419, and module-073.ll:69-77.
  // Height <= 0 is an adapter guard, not a recovered native branch.
  if (height <= 0.0) return 0.0;
  float t = clamp(-signedDistance / height, 0.0, 1.0);
  return amount * (1.0 - clamp(sqrt(t * (2.0 - t)), 0.0, 1.0));
}

float recoveredDistanceBlur(
  float refractedDistance, float blurRadius, vec4 blurAlpha, vec4 blurDistance
) {
  // module-064.ll:421-462. refractedDistance is distance + inner displacement.
  // The caller must supply actual, strictly increasing blurDistance values.
  // No invented native alpha/distance arrays are provided by this module.
  vec3 blend = clamp(
    (vec3(refractedDistance) - blurDistance.xyz) /
      (blurDistance.yzw - blurDistance.xyz), 0.0, 1.0
  );
  return blurRadius * (blurAlpha.x - dot(blurAlpha.yzw, blend));
}

float recoveredBlurLod(float blurRadiusInTexturePixels) {
  // module-064.ll:473-478. Negative input is guarded by this adapter.
  float radius = max(blurRadiusInTexturePixels, 0.0);
  return max(0.0, log2(radius < 2.0 ? 1.0 + radius * 0.5 : radius));
}

vec3 recoveredBackgroundLod(vec2 cssPoint, float lod) {
  // This demo uploads top-to-bottom canvas data and uses top-to-bottom CSS UVs.
  vec2 uv = clamp(cssPoint / u_cssSize, vec2(0.0), vec2(1.0));
  return textureLod(u_background, uv, lod).rgb;
}

vec3 recoveredSpectralIntegration(vec2 samplePoint, vec2 spectralShift, float lod) {
  // module-073.ll:122-194: three positive and four negative spectral taps.
  // The final native RGB normalization is (1/2, 1/3, 1/2).
  // Opaque-background adaptation: native unpremultiply/alpha/HDR are omitted.
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 3; ++i) {
    float w = 1.0 - float(i) / 3.0;
    vec3 value = recoveredBackgroundLod(samplePoint + w * spectralShift, lod);
    sum += value * vec3(w * 0.5, (1.0 - w) / 3.0, 0.0);
  }
  for (int i = 0; i < 4; ++i) {
    float w = float(i) / 3.0;
    vec3 value = recoveredBackgroundLod(samplePoint - w * spectralShift, lod);
    sum += value * vec3(0.0, (1.0 - w) / 3.0, w * 0.5);
  }
  return sum;
}

vec3 recoveredGlassSample(
  vec2 cssPoint, vec2 normal, float signedDistance, float amount, float height,
  float blurRadius, float aberrationAmount
) {
  float displacement = recoveredRefractionEnvelope(signedDistance, amount, height);
  vec2 samplePoint = cssPoint + normal * displacement;
  // Signature has no native blurAlpha/blurDistance arrays, so this entry point
  // uses a fixed radius. recoveredDistanceBlur is available for a later port.
  // Convert CSS blur footprint to texture pixels before choosing a mip level.
  vec2 textureScale = vec2(textureSize(u_background, 0)) / u_cssSize;
  float pixelScale = max(textureScale.x, textureScale.y);
  float lod = recoveredBlurLod(blurRadius * pixelScale);
  float aberration = recoveredRefractionEnvelope(
    signedDistance, aberrationAmount, height
  );
  // At zero shift the seven taps are identical; one sample is equivalent.
  if (aberrationAmount == 0.0 || aberration == 0.0) {
    return recoveredBackgroundLod(samplePoint, lod);
  }
  // Native aberration has its own direction, inverse height and offset.
  // This interface shares the normal/height with refraction as an adaptation.
  return recoveredSpectralIntegration(samplePoint, normal * aberration, lod);
}
`;

const saturate = value => Math.min(1, Math.max(0, value));

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function vector(value, length, name) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new TypeError(`${name} must contain ${length} finite numbers`);
  }
  return value;
}

/** Exact algebraic envelope from AIR; signed amounts are preserved. */
function refractionEnvelope(signedDistance, amount, height, offset = 0) {
  finite(signedDistance, 'signedDistance');
  finite(amount, 'amount');
  finite(height, 'height');
  finite(offset, 'offset');
  if (height <= 0) return 0; // Adapter input policy, not a native parameter rule.
  const t = saturate((-signedDistance - offset) / height);
  return amount * (1 - saturate(Math.sqrt(t * (2 - t))));
}

/**
 * module-064.ll:421-462. Supply runtime arrays explicitly; no native values are
 * assumed. The distance argument already includes the refraction displacement.
 */
function distanceDependentBlur(refractedDistance, blurRadius, blurAlpha, blurDistance) {
  finite(refractedDistance, 'refractedDistance');
  finite(blurRadius, 'blurRadius');
  vector(blurAlpha, 4, 'blurAlpha');
  vector(blurDistance, 4, 'blurDistance');
  let scale = blurAlpha[0];
  for (let i = 0; i < 3; ++i) {
    const width = blurDistance[i + 1] - blurDistance[i];
    if (width <= 0) throw new RangeError('blurDistance must be strictly increasing');
    scale -= blurAlpha[i + 1] * saturate((refractedDistance - blurDistance[i]) / width);
  }
  return blurRadius * scale;
}

/** module-064.ll:473-478; radius is measured in texture pixels. */
function blurRadiusToLod(blurRadiusInTexturePixels) {
  const radius = Math.max(0, finite(blurRadiusInTexturePixels, 'blurRadiusInTexturePixels'));
  return Math.max(0, Math.log2(radius < 2 ? 1 + radius * 0.5 : radius));
}

// Algebraic normalization of module-073.ll:122-194. Each RGB channel sums to 1.
const SPECTRAL_TAPS = Object.freeze([
  ...Array.from({ length: 3 }, (_, i) => {
    const w = 1 - i / 3;
    return Object.freeze({ offset: w, weights: Object.freeze([w / 2, (1 - w) / 3, 0]) });
  }),
  ...Array.from({ length: 4 }, (_, i) => {
    const w = i / 3;
    return Object.freeze({ offset: -w, weights: Object.freeze([0, (1 - w) / 3, w / 2]) });
  }),
]);

/** Opaque SDR CPU reference for the GLSL seven-tap integration. */
function integrateSpectral(sampleAt, samplePoint, spectralShift, lod = 0) {
  if (typeof sampleAt !== 'function') throw new TypeError('sampleAt must be a function');
  vector(samplePoint, 2, 'samplePoint');
  vector(spectralShift, 2, 'spectralShift');
  finite(lod, 'lod');
  if (spectralShift[0] === 0 && spectralShift[1] === 0) {
    return [...vector(sampleAt([...samplePoint], lod), 3, 'sample RGB')];
  }
  const result = [0, 0, 0];
  for (const { offset, weights } of SPECTRAL_TAPS) {
    const point = samplePoint.map((value, axis) => value + offset * spectralShift[axis]);
    const rgb = vector(sampleAt(point, lod), 3, 'sample RGB');
    for (let channel = 0; channel < 3; ++channel) result[channel] += weights[channel] * rgb[channel];
  }
  return result;
}

/** CPU reference for the same small-interface inner path used by GLSL. */
function recoveredGlassSampleJS({
  sampleAt, cssPoint, normal, signedDistance, amount, height,
  blurRadius, aberrationAmount, texturePixelScale = 1,
}) {
  vector(cssPoint, 2, 'cssPoint');
  vector(normal, 2, 'normal');
  const displacement = refractionEnvelope(signedDistance, amount, height);
  const aberration = refractionEnvelope(signedDistance, aberrationAmount, height);
  const samplePoint = cssPoint.map((value, axis) => value + normal[axis] * displacement);
  const shift = normal.map(value => value * aberration);
  finite(blurRadius, 'blurRadius');
  finite(texturePixelScale, 'texturePixelScale');
  if (texturePixelScale <= 0) throw new RangeError('texturePixelScale must be positive');
  return integrateSpectral(sampleAt, samplePoint, shift, blurRadiusToLod(blurRadius * texturePixelScale));
}

return {RECOVERED_OPTICS_GLSL,refractionEnvelope,distanceDependentBlur,blurRadiusToLod,SPECTRAL_TAPS,integrateSpectral,recoveredGlassSampleJS};
})();

// core/recovered-composite.js
const m4=(()=>{
/**
 * Instruction-derived glassBackground composition for an OPAQUE SDR backdrop.
 * Evidence: research/deep/air-analysis/module-064.ll, lines cited below.
 *
 * Coordinates/distance/width and GEOMETRIC uniforms use the SAME caller-selected
 * space (the browser adapter uses CSS pixels). Blur footprints are independently
 * CPU-packed in source texture pixels and are never multiplied by DPR implicitly.
 * Source RGBA is sampled from an
 * opaque backdrop; transparent-source spectral/HDR capture is not reconstructed.
 * Returned RGBA is PREMULTIPLIED: use ONE, ONE_MINUS_SRC_ALPHA when blending.
 * No implicit framebuffer clamp is performed by the recovered arithmetic.
 *
 * KVC inputs are NOT the expanded AIR uniform buffer. makeCompositeParams uses
 * decoded CPU YCC matrix/opacity-difference lowering and labels unresolved color
 * conversion, scale, flags and degenerate-interval conventions individually.
 */

const EPS = 1e-6;
const sat = x => Math.min(1, Math.max(0, x));
const mix = (a, b, t) => a + (b - a) * t;
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const vMix = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const scale = (a, s) => a.map(v => v * s);
const add = (a, b) => a.map((v, i) => v + b[i]);
const clean = x => Math.abs(x) < EPS ? 0 : x;
const finite = x => Number.isFinite(x);
const vec = (value, size, label) => {
  if (!Array.isArray(value) || value.length !== size || !value.every(finite)) throw new TypeError(`${label} requires ${size} finite values`);
  return [...value];
};

// Names follow decoded AIR semantics, with compact camelCase names for WebGL.
const COMPOSITE_UNIFORM_TYPES = Object.freeze({
  displacementMat: 'vec4', shadowOffset: 'vec2', ringOffset: 'vec2',
  innerAmount: 'float', innerInvHeight: 'float', outerAmount: 'float', outerInvHeight: 'float',
  refractionThreshold: 'vec2', refractionOpacity: 'float', blurRadius: 'float',
  blurAlpha: 'vec4', blurDistance: 'vec4', useDistanceBlur: 'bool',
  bleedAmount: 'float', bleedInvHeight: 'float', bleedBlurRadius: 'float',
  bleedDistance: 'vec2', bleedOpacity: 'float', bleedDarken: 'vec2',
  shadowAmount: 'float', shadowInvHeight: 'float', shadowBlurRadius: 'float',
  shadowInvRadius: 'float', shadowDistanceOffset: 'float', shadowOpacity: 'float',
  shadowContribution: 'float', shadowFaceOpacity: 'float',
  ringStrokeWidth: 'float', ringRadius: 'float', ringOpacity: 'float', ringMask: 'float',
  keyDirection: 'vec2', keyHeight: 'float', keySpread: 'float', keyAmount: 'float',
  keyEffectOffset: 'float', keyColorBias: 'float', strokeMode: 'bool',
  highlightExtension: 'bool', biasCorrection: 'bool',
  faceOpacity: 'float', faceMaxLumaComplement: 'float',
  face0: 'vec4', face1: 'vec4', face2: 'vec4',
  bleed0: 'vec4', bleed1: 'vec4', bleed2: 'vec4',
  shadow0: 'vec4', shadow1: 'vec4', shadow2: 'vec4',
  blurFillRadius: 'float', blurFillLighten: 'float', blurFillDarken: 'float',
  blurFillNormal: 'float', blurFillEnabled: 'bool',
  holdingToneOpacity: 'float', sdrShadowDistance0: 'float', sdrShadowInv: 'float',
  sdrWhiteValue: 'float', clampLimit: 'float', preserveHue: 'bool', edrScale: 'float',
  aberrationAmount: 'float', aberrationInvHeight: 'float', aberrationOffset: 'float', aberrationDirection: 'vec2',
});

// module-064.ll:405-419 and 619-632. Inverse-height form avoids inventing a
// division-by-zero convention inside the instruction-derived primitive.
function compositeEnvelope(distance, amount, inverseHeight) {
  const t = sat(-distance * inverseHeight);
  return amount * (1 - sat(Math.sqrt(t * (2 - t))));
}

// module-064.ll:473-478. Input footprint is in source texture pixels.
function compositeLod(radius) {
  return Math.max(0, Math.log2(radius < 2 ? 1 + radius * 0.5 : radius));
}

// module-064.ll:431-462. Only valid expanded arrays, not raw KVC zero-distance
// arrays, may be passed. No order guard changes the recovered expression.
function compositeDistanceBlur(x, radius, alpha, distances) {
  return radius * (alpha[0] - alpha.slice(1).reduce((sum, a, i) => {
    if (a === 0) return sum;
    const width = distances[i + 1] - distances[i];
    // Raw presets contain collapsed intervals. A right-continuous step is an
    // explicit browser limit convention; AIR 0/0 + fast-math remains unverified.
    const ramp = width === 0 ? (x >= distances[i] ? 1 : 0) : sat((x - distances[i]) / width);
    return sum + a * ramp;
  }, 0));
}

// module-064.ll:278-288. Coefficients are exact decoded half constants; these
// JS/GLSL versions promote their operations to float, rather than emulate each
// half rounding and AIR fused operation. That precision difference is explicit.
function compositeShadowFalloff(x) {
  const z = 4 * sat(0.25 * x + 0.5) - 2, q = z * z;
  return (((0.0029544830322265625 * q - 0.034454345703125) * q + 0.168212890625) * q - 0.560546875) * z + 0.5;
}

// module-064.ll:691-744. Each row is [r,g,b,offset], NOT a mat4 column.
function compositeColorMatrix(rgb, rows, contribution = 1) {
  return rows.map(row => dot(rgb, row.slice(0, 3)) * contribution + row[3]);
}

// module-064.ll:78-188. sdfWidth is max(fwidth(d),0.0001), supplied by caller.
function compositeHighlight(distance, normal, mask, sdfAlpha, sdfWidth, p) {
  if (!(p.keyHeight > 0)) return 0;
  const d = distance + p.keyEffectOffset, halfWidth = sdfWidth * 0.5;
  if (d >= halfWidth || (p.strokeMode ? mask >= 1 : -d >= p.keyHeight + halfWidth) || !sdfAlpha) return 0;
  let gain = 1, band = 1 - mask;
  if (!p.strokeMode) {
    const ramp = 1 - sat(-d / p.keyHeight);
    gain = mix(ramp !== 0 ? 1 : 0, ramp, 0.75);
    band = sat((d + p.keyHeight) / sdfWidth + 0.5);
  }
  const amplitude = gain * sdfAlpha * band * sat(-d / sdfWidth + 0.5);
  const n = dot(p.keyDirection, normal), denominator = Math.max(1 - p.keySpread, EPS);
  return [n, -n].reduce((sum, value) => {
    const h = sat((value - p.keySpread) / denominator) * amplitude;
    return sum + h / Math.max(1 + p.keyAmount * (1 - h), EPS);
  }, 0);
}

// module-064.ll:192-250. shiftedSdf=(distance, shapeAlpha) sampled after ring offset.
function compositeRingShadow(shiftedSdf, mask, p) {
  if (!(p.ringOpacity > 0) || !(mask > 0 || p.ringMask < 1)) return 0;
  const radius = Math.max(p.ringRadius, EPS), x = shiftedSdf[0] / radius;
  const falloff = sat(compositeShadowFalloff(x * Math.SQRT1_2) - compositeShadowFalloff((x + p.ringStrokeWidth / radius) * Math.SQRT1_2));
  return p.ringOpacity * shiftedSdf[1] * falloff * mix(1, mask, p.ringMask);
}

// module-064.ll:813-840; the fourth power is literal, not a fitted opacity curve.
function compositeBleedWeight(distance, faceRgb, p) {
  const luma = sat(dot(faceRgb, [0.21250000596046448, 0.715399980545044, 0.07209999859333038]));
  const darken = p.bleedDarken[0] * luma + p.bleedDarken[1];
  const edge = sat((distance - p.bleedDistance[0]) / (p.bleedDistance[1] - p.bleedDistance[0]));
  return p.bleedOpacity * (darken * darken * edge) ** 2;
}

// module-064.ll:684-743. The max-luma complement is an expanded uniform; it
// is deliberately NOT guessed from the KVC field named inputFaceColorMatrixMaxLuma.
function faceColor(rgb, p) {
  let input = rgb;
  if (p.faceMaxLumaComplement > 0) {
    const luma = dot(rgb, [0.2126000076532364, 0.7152000069618225, 0.0722000002861023]);
    const attenuation = sat(1 - luma * p.faceMaxLumaComplement);
    input = vMix([luma * attenuation, luma * attenuation, luma * attenuation], scale(rgb, attenuation), 1 + (1 - attenuation) * 0.30000001192092896);
  }
  return compositeColorMatrix(input, [p.face0, p.face1, p.face2]);
}

// module-064.ll:1010-1122. Input/output are premultiplied; alpha is never
// multiplied by edrScale. This implements scalar math, not HDR color capture.
function compositeFinish(rgba, distance, p) {
  let result = [...rgba];
  if (p.holdingToneOpacity > 0) {
    const a = sat(result[3]);
    const mapped = [...scale(result.slice(0, 3), p.sdrWhiteValue * a / Math.max(result[3], EPS)), a];
    const weight = (1 - sat((distance - p.sdrShadowDistance0) * p.sdrShadowInv)) * p.holdingToneOpacity;
    result = vMix(result, mapped, weight);
  }
  if (p.clampLimit > 0) {
    let rgb = scale(result.slice(0, 3), 1 / Math.max(result[3], EPS));
    if (p.preserveHue) {
      const maximum = Math.max(...rgb);
      if (maximum > p.clampLimit) rgb = scale(rgb, p.clampLimit / maximum);
    } else rgb = rgb.map(x => Math.min(p.clampLimit, Math.max(-0.75, x)));
    result = [...scale(rgb, result[3]), result[3]];
  }
  return [...scale(result.slice(0, 3), p.edrScale), result[3]];
}

/**
 * CPU reference. sampleAt(cssPoint,lod) returns opaque premultiplied RGBA.
 * shadowSdf/ringSdf must come from the same SDF evaluated at their offset points;
 * they are not inferred from the central distance. Output is premultiplied RGBA.
 */
function recoveredCompositeSampleJS({ cssPoint, normal, signedDistance: d, sdfAlpha, sdfWidth, shadowSdf, ringSdf, params, sampleAt, texturePixelScale = [1, 1] }) {
  const p = params.uniforms || params;
  vec(cssPoint, 2, 'cssPoint'); vec(normal, 2, 'normal'); vec(shadowSdf, 2, 'shadowSdf'); vec(ringSdf, 2, 'ringSdf');
  vec(texturePixelScale, 2, 'texturePixelScale');
  const width = Math.max(sdfWidth, 0.0001), mask = sat(0.5 - d / width) * sdfAlpha;
  const direction = [dot(normal, p.displacementMat.slice(0, 2)), dot(normal, p.displacementMat.slice(2, 4))];
  const sample = (point, radius) => vec(sampleAt(point, compositeLod(radius)), 4, 'sample RGBA');
  const plain = (point, radius) => { const value = sample(point, radius); return [...scale(value.slice(0, 3), 1 / Math.max(value[3], EPS)).map(clean), value[3]]; };
  const atShift = displacement => cssPoint.map((x, i) => x + direction[i] * displacement);
  const blurAt = x => p.useDistanceBlur ? compositeDistanceBlur(x, p.blurRadius, p.blurAlpha, p.blurDistance) : p.blurRadius;
  const highlight = compositeHighlight(d, normal, mask, sdfAlpha, width, p);
  const ring = compositeRingShadow(ringSdf, mask, p);
  let shadow = [0, 0, 0, 0];
  if (mask < 1) {
    const shadowShape = p.shadowOpacity * shadowSdf[1] * compositeShadowFalloff(p.shadowInvRadius * shadowSdf[0]);
    if (mask === 0 && shadowShape < EPS && highlight < EPS && ring < EPS) return shadow;
    if (p.shadowContribution > EPS) {
      const displacement = compositeEnvelope(d + p.shadowDistanceOffset, p.shadowAmount, p.shadowInvHeight);
      const color = compositeColorMatrix(plain(atShift(displacement), p.shadowBlurRadius).slice(0, 3), [p.shadow0, p.shadow1, p.shadow2], p.shadowContribution);
      shadow = [...color, mix(p.shadowFaceOpacity, 1, p.shadowContribution)];
    } else shadow = [p.shadow0[3], p.shadow1[3], p.shadow2[3], p.shadowFaceOpacity];
    shadow = scale(shadow, shadowShape);
  }
  let inside = [0, 0, 0, 0];
  if (mask > 0) {
    const displacement = compositeEnvelope(d, p.innerAmount, p.innerInvHeight);
    const radius = blurAt(d + displacement), center = atShift(displacement);
    let source;
    if (p.aberrationAmount === 0) source = plain(center, radius).slice(0, 3);
    if (p.aberrationAmount !== 0) {
      // Opaque-source adaptation of module-064.ll:1177-1364: seven spectral
      // positions, four diagonal samples per position when blur is enabled.
      const q = compositeEnvelope(d + p.aberrationOffset, p.aberrationAmount, p.aberrationInvHeight);
      const a = p.displacementMat, v = p.aberrationDirection;
      const shift = [dot([dot(a.slice(2), v), v[0] * a[3] - v[1] * a[2]], normal), dot([dot(a.slice(0, 2), v), v[0] * a[1] - v[1] * a[0]], normal)].map(x => x * q);
      const lod = compositeLod(radius), delta = texturePixelScale.map(s => lod * 0.25 / s), sum = [0, 0, 0];
      const spectralSample = point => {
        let total = [0, 0, 0, 0];
        for (const x of [-1, 1]) for (const y of [-1, 1]) total = add(total, vec(sampleAt([point[0] + x * delta[0], point[1] + y * delta[1]], lod), 4, 'spectral RGBA'));
        total = scale(total, 0.25);
        return scale(total.slice(0, 3), 1 / Math.max(total[3], EPS)).map(clean);
      };
      for (let i = 0; i < 7; i++) {
        const positive = i < 3, w = positive ? 1 - i / 3 : (i - 3) / 3;
        const point = center.map((x, axis) => x + (positive ? w : -w) * shift[axis]);
        const value = spectralSample(point), weights = positive ? [w / 2, (1 - w) / 3, 0] : [0, (1 - w) / 3, w / 2];
        for (let c = 0; c < 3; c++) sum[c] += value[c] * weights[c];
      }
      source = sum;
    }
    if (p.blurFillEnabled) {
      const lod = compositeLod(p.blurFillRadius), delta = texturePixelScale.map(s => lod * 0.25 / s);
      const a = vec(sampleAt(add(cssPoint, delta), lod), 4, 'fill RGBA'), b = vec(sampleAt(add(cssPoint, scale(delta, -1)), lod), 4, 'fill RGBA');
      const value = scale(add(a, b), 0.5), fill = scale(value.slice(0, 3), 1 / Math.max(value[3], EPS)).map(clean);
      source = source.map((x, i) => mix(x * (1 - p.blurFillDarken - p.blurFillLighten) + Math.min(x, fill[i]) * p.blurFillDarken + Math.max(x, fill[i]) * p.blurFillLighten, fill[i], p.blurFillNormal));
    }
    inside = [...source, 1];
    if (p.refractionOpacity > 0) {
      const outer = compositeEnvelope(d, p.outerAmount, p.outerInvHeight);
      const value = sample(atShift(outer), blurAt(d + outer));
      value[0] = clean(value[0]); value[1] = clean(value[1]); value[2] = clean(value[2]);
      inside = vMix(inside, value, p.refractionOpacity * sat((d - p.refractionThreshold[0]) / (p.refractionThreshold[1] - p.refractionThreshold[0])));
    }
    if (p.faceOpacity > 0) inside = [...vMix(inside.slice(0, 3), faceColor(inside.slice(0, 3), p), p.faceOpacity), inside[3]];
    // module-064.ll:744-862: bleed is still evaluated when its opacity is zero;
    // skipping that no-op here avoids unnecessary Web texture reads.
    if (p.bleedOpacity !== 0) {
      const bleed = compositeEnvelope(d, p.bleedAmount, p.bleedInvHeight);
      const color = compositeColorMatrix(plain(atShift(bleed), p.bleedBlurRadius).slice(0, 3), [p.bleed0, p.bleed1, p.bleed2]);
      inside = [...vMix(inside.slice(0, 3), color, compositeBleedWeight(d, inside.slice(0, 3), p)), inside[3]];
    }
  }
  let result = vMix(shadow, inside, mask);
  result = add(scale(result, 1 - ring), [0, 0, 0, ring]);
  // module-064.ll:857-1007: fill alpha holes before biasing, then subtract the
  // unfilled backdrop contribution. This is not ordinary additive rim lighting.
  if (highlight > EPS) {
    const oldAlpha = result[3]; let color = result.slice(0, 3), background = [0, 0, 0];
    if (oldAlpha < 1) {
      background = plain(cssPoint, 0).slice(0, 3);
      let adjusted = background;
      if (p.faceOpacity > 0) {
        adjusted = faceColor(background, p);
        if (p.biasCorrection) adjusted = adjusted.map((x, i) => p.keyColorBias < 0 ? Math.min(x, background[i]) : Math.max(x, background[i]));
        adjusted = vMix(background, adjusted, p.faceOpacity * highlight);
      }
      color = add(color, scale(adjusted, 1 - oldAlpha));
    }
    const alpha = oldAlpha + (1 - oldAlpha) * highlight * (p.highlightExtension ? 1 : 0);
    color = color.map((x, i) => x * (1 + p.keyColorBias * highlight * (3 - 2 * x)) - (1 - alpha) * background[i]);
    result = [...color, alpha];
  }
  return compositeFinish(result, d, p);
}

function colorComponents(value) {
  const components = value?.color?.components || value?.components;
  if (Array.isArray(components) && components.length === 4 && components.every(finite)) return components;
  return null;
}

const RGB_TO_YCC = [[0.2125999927520752,0.7152000069618225,0.0722000002861023,0,0],[-0.11460000276565552,-0.3853999972343445,0.5,0,0.5],[0.5,-0.45419999957084656,-0.04580000042915344,0,0.5],[0,0,0,1,0]];
const YCC_TO_RGB = [[1,0,1.5748000144958496,0,-0.7874000072479248],[1,-0.18732400238513947,-0.46812400221824646,0,0.32772400975227356],[1,1.8555999994277954,0,0,-0.9277999997138977],[0,0,0,1,0]];
const affineIdentity = () => [[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0],[0,0,0,1,0]];

// Round to nearest IEEE binary16, ties-to-even. Matrix coefficients are small;
// finite normal/subnormal values and the actual half storage are handled here.
function roundCompositeHalf(value) {
  value = Math.fround(value);
  if (!finite(value) || value === 0) return value;
  const sign = value < 0 ? -1 : 1, absolute = Math.abs(value);
  const step = absolute < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(absolute)) - 10);
  const scaled = absolute / step, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = fraction > .5 || (fraction === .5 && lower % 2) ? lower + 1 : lower;
  const output = rounded * step;
  return output > 65504 ? sign * Infinity : sign * output;
}

function concatAffine(a,b) {
  return a.map(row => Array.from({length:5},(_,column) => {
    let sum=column===4?row[4]:0;
    for(let k=0;k<4;k++)sum=Math.fround(row[k]*b[k][column]+sum);
    return sum;
  }));
}

/**
 * CPU set_ycc_composite @18B1878AC, concat @18B187A58; constant tables at
 * 18B3F03B0/18B3F0400. fill must already be the Render float premultiplied color.
 * Native CGColor->Render conversion is outside this recovered helper.
 */
function recoveredYccColorMatrix(white,black,saturation,premultipliedFill,{quantizeHalf=true}={}) {
  vec(premultipliedFill,4,'premultipliedFill');
  if(![white,black,saturation].every(finite))throw new TypeError('YCC parameters must be finite');
  const contrast=affineIdentity();contrast[0][0]=Math.fround(white-black);contrast[0][4]=Math.fround(black);
  const saturationMatrix=affineIdentity();
  saturationMatrix[1][1]=saturationMatrix[2][2]=Math.fround(saturation);
  saturationMatrix[1][4]=saturationMatrix[2][4]=Math.fround(.5*(1-saturation));
  let matrix=concatAffine(YCC_TO_RGB,concatAffine(saturationMatrix,concatAffine(contrast,RGB_TO_YCC)));
  const attenuation=Math.fround(1-premultipliedFill[3]);
  matrix=matrix.map(row=>row.map(x=>Math.fround(x*attenuation)));
  for(let row=0;row<3;row++)matrix[row][4]=Math.fround(matrix[row][4]+premultipliedFill[row]);
  matrix[3][3]=Math.fround(matrix[3][3]+premultipliedFill[3]);
  return matrix.slice(0,3).map(row=>[row[0],row[1],row[2],row[4]].map(x=>quantizeHalf?roundCompositeHalf(x):x));
}

function decodeOffset(value) {
  if (value?.objcType !== '{CGSize=dd}' || !value.rawBytesBase64) return null;
  const bytes = Uint8Array.from(atob(value.rawBytesBase64), c => c.charCodeAt(0));
  if (bytes.length !== 16) return null;
  const view = new DataView(bytes.buffer);
  return [view.getFloat64(0, true), view.getFloat64(8, true)];
}

/**
 * Expanded uniforms + explicit provenance. Options:
 * rawToCss (geometry only), surfaceScale, contextTransformScale,
 * blurPackingScale (explicit source-texture-pixel multiplier), textureScale,
 * displacementMat, shadowOffset, ringOffset, headroomMix (SDR default 0),
 * faceRows/bleedRows/shadowRows or matrixProvider(kind,raw)->{rows,source},
 * floatFillColors.{face,bleed,shadow} (already Render float premultiplied),
 * quantizeMatrices (default true, native AIR half4 storage),
 * blurAlpha/blurDistance (EXPANDED uniforms), highlightSpreadCoefficient,
 * bleedDarken, shadowInvRadius, faceMaxLumaComplement, strokeMode, highlightExtension,
 * biasCorrection, holdingToneOpacity, sdrWhiteValue, edrScale, aberration*.
 *
 * Missing native lowering remains listed as unresolved. Adapter constants only
 * configure this browser presentation; none is presented as a measured value.
 */
function makeCompositeParams(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('raw filter inputs are required');
  const unresolved = [], provenance = { coordinates: null, matrices: {}, scalarLowering: 'instruction-derived CPU packing where cited; not a captured AIR uniform buffer' };
  const factor = options.rawToCss ?? 1;
  if (!finite(factor) || factor <= 0) throw new RangeError('rawToCss must be positive and finite');
  provenance.coordinates = options.rawToCss == null ? 'adapter identity scale, not calibrated' : `caller-provided rawToCss=${factor}`;
  if (options.rawToCss == null) unresolved.push('Native raw units to CSS mapping is uncalibrated.');
  const value = (key, fallback = 0) => {
    if (finite(raw[key])) return raw[key];
    unresolved.push(`${key} is unresolved; affected browser branch uses explicit adapter value ${fallback}.`);
    return fallback;
  };
  const dimensional = key => value(key) * factor, inverse = key => { const h = dimensional(key); return h > 0 ? 1 / h : 0; };
  const surfaceScale=options.surfaceScale??1, transformScale=options.contextTransformScale??1;
  const blurPackingScale=options.blurPackingScale??1.600000023841858*surfaceScale*transformScale;
  if(!finite(blurPackingScale)||blurPackingScale<=0)throw new RangeError('blurPackingScale must be positive');
  const blurRadius=key=>value(key)*blurPackingScale;
  provenance.blurPacking={factor:blurPackingScale,nativeConstant:1.600000023841858,surfaceScale:options.surfaceScale??null,contextTransformScale:options.contextTransformScale??null,textureScale:options.textureScale??null,units:'source texture pixels; no implicit DPR multiplication'};
  if(options.blurPackingScale==null && (options.surfaceScale==null||options.contextTransformScale==null))unresolved.push('CPU blur factor 1.6 is recovered, but surfaceScale/contextTransformScale are unresolved; browser uses explicit unit factors of 1.');
  const headroomMix=options.headroomMix??0;
  if(!finite(headroomMix))throw new TypeError('headroomMix must be finite');
  provenance.headroom=options.headroomMix==null?'browser SDR endpoint 0, not measured context headroom':'caller supplied headroom mix';
  const matrices = {};
  for (const kind of ['Face', 'Bleed', 'Shadow']) {
    const explicit = options[`${kind.toLowerCase()}Rows`], supplied = explicit || options.matrixProvider?.(kind.toLowerCase(), raw);
    const rows = explicit || supplied?.rows || (Array.isArray(supplied) ? supplied : null);
    if (rows) {
      if (!Array.isArray(rows) || rows.length !== 3) throw new TypeError(`${kind} matrix requires three rows`);
      matrices[kind] = rows.map(row => vec(row, 4, `${kind} row`).map(x=>options.quantizeMatrices===false?x:roundCompositeHalf(x)));
      provenance.matrices[kind.toLowerCase()] = explicit ? 'caller explicit rows' : supplied.source || 'caller matrixProvider rows';
    } else {
      const prefix=`input${kind}ColorMatrix`, explicitFill=options.floatFillColors?.[kind.toLowerCase()];
      const cg=colorComponents(raw[`${prefix}FillColor`]);
      const fill=explicitFill?vec(explicitFill,4,`${kind} Render fill`):cg?[cg[0]*cg[3],cg[1]*cg[3],cg[2]*cg[3],cg[3]]:[0,0,0,0];
      matrices[kind]=recoveredYccColorMatrix(value(`${prefix}White`,1),value(`${prefix}Black`),value(`${prefix}Saturation`,1),fill,{quantizeHalf:options.quantizeMatrices!==false});
      provenance.matrices[kind.toLowerCase()]=`CPU-decoded YCC chain; ${options.quantizeMatrices===false?'float diagnostic, half storage disabled':'binary16 rows'}; ${explicitFill?'caller Render float fill':'ADAPTER CGColor premultiply/color-space mapping'}`;
      if(!explicitFill)unresolved.push(`${kind} CGColor-to-Render float-color conversion is unverified; explicit premultiply/color-space adapter supplies the recovered YCC helper.`);
    }
  }
  const opacityInputs = [0,1,2,3].map(i => raw[`inputBlurOpacity${i}`]);
  const distanceInputs = [0,1,2,3].map(i => raw[`inputBlurDistance${i}`]);
  const haveNativeBlur = opacityInputs.every(finite) && distanceInputs.every(finite);
  const explicitBlur = options.blurAlpha != null && options.blurDistance != null;
  const distanceBlur = options.useDistanceBlur ?? (explicitBlur || haveNativeBlur);
  // CPU render @18B19C504..518,C7EC..808: alpha0=opacity0, subsequent
  // alpha values are adjacent differences; distances are packed directly.
  const blurAlpha = explicitBlur ? vec(options.blurAlpha,4,'blurAlpha') : haveNativeBlur ? [opacityInputs[0],opacityInputs[0]-opacityInputs[1],opacityInputs[1]-opacityInputs[2],opacityInputs[2]-opacityInputs[3]] : [0,0,0,0];
  const blurDistance = explicitBlur ? vec(options.blurDistance,4,'blurDistance') : haveNativeBlur ? distanceInputs.map(x=>x*factor) : [0,0,0,0];
  provenance.blur = explicitBlur ? 'caller expanded arrays' : haveNativeBlur ? 'CPU-decoded adjacent opacity differences and direct distances' : 'fixed-radius browser fallback; arrays unavailable';
  if (!distanceBlur) unresolved.push('Distance-dependent blur is disabled; fixed-radius browser fallback is in use.');
  if (distanceBlur && blurDistance.some((x,i)=>i && x===blurDistance[i-1])) unresolved.push('Collapsed blur-distance intervals use an explicit right-continuous step limit; native AIR fast-math 0/0 behavior is unverified.');
  const angle = value('inputKeyFillHighlightAngle');
  const spread = mix(value('inputKeyFillHighlightSpreadSDR'),value('inputKeyFillHighlightSpread'),headroomMix);
  const shadowOffset = options.shadowOffset || decodeOffset(raw.inputShadowOffset)?.map(x => x * factor) || [0, 0];
  const ringOffset = options.ringOffset || [0, dimensional('inputRingShadowOffset')];
  if (!options.shadowOffset || !options.ringOffset) unresolved.push('Offset sign/coordinate lowering needs calibration; raw CGSize and vertical ring-offset adapter exposed for auxiliary SDF evaluation.');
  if (options.shadowInvRadius == null) unresolved.push('shadow_inv_radius lowering unverified; inverse raw radius with a zero-radius sharp-step limit is a browser adapter, not a captured coefficient.');
  const blend = value('inputBleedDarkenBlend'), blurLight = value('inputBlurFillLightenOpacity'), blurDark = value('inputBlurFillDarkenOpacity'), blurNormal = value('inputBlurFillNormalOpacity');
  const shadowFill = colorComponents(raw.inputShadowColorMatrixFillColor);
  const p = {
    displacementMat: vec(options.displacementMat || [1, 0, 0, 1], 4, 'displacementMat'), shadowOffset: vec(shadowOffset, 2, 'shadowOffset'), ringOffset: vec(ringOffset, 2, 'ringOffset'),
    innerAmount: dimensional('inputInnerRefractionAmount'), innerInvHeight: inverse('inputInnerRefractionHeight'), outerAmount: dimensional('inputOuterRefractionAmount'), outerInvHeight: inverse('inputOuterRefractionHeight'),
    refractionThreshold: [dimensional('inputRefractionDistance0'), dimensional('inputRefractionDistance1')], refractionOpacity: value('inputRefractionOpacity'), blurRadius: blurRadius('inputBlurRadius'),
    blurAlpha, blurDistance, useDistanceBlur: distanceBlur,
    bleedAmount: dimensional('inputBleedAmount'), bleedInvHeight: inverse('inputBleedHeight'), bleedBlurRadius: blurRadius('inputBleedBlurRadius'), bleedDistance: [dimensional('inputBleedDistance0'), dimensional('inputBleedDistance1')], bleedOpacity: value('inputBleedOpacity'), bleedDarken: vec(options.bleedDarken || (blend?[1,0]:[-1,1]), 2, 'bleedDarken'),
    shadowAmount: dimensional('inputShadowAmount'), shadowInvHeight: inverse('inputShadowHeight'), shadowBlurRadius: blurRadius('inputShadowBlurRadius'), shadowInvRadius: options.shadowInvRadius ?? 1 / Math.max(dimensional('inputShadowRadius'), EPS), shadowDistanceOffset: dimensional('inputShadowDistanceOffset'), shadowOpacity: value('inputShadowOpacity'), shadowContribution: value('inputShadowVibrancyContribution'), shadowFaceOpacity: options.shadowFaceOpacity ?? shadowFill?.[3] ?? 0,
    ringStrokeWidth: dimensional('inputRingShadowStrokeWidth'), ringRadius: dimensional('inputRingShadowBlurRadius'), ringOpacity: value('inputRingShadowOpacity'), ringMask: value('inputRingShadowMask'),
    keyDirection: vec(options.keyDirection || [Math.sin(angle), -Math.cos(angle)], 2, 'keyDirection'), keyHeight: dimensional('inputKeyFillHighlightHeight'), keySpread: options.highlightSpreadCoefficient ?? Math.cos(spread), keyAmount: value('inputKeyFillHighlightAmount'), keyEffectOffset: dimensional('inputKeyFillHighlightEffectOffset'), keyColorBias: value('inputKeyFillHighlightColorBias'), strokeMode: !!options.strokeMode, highlightExtension: !!options.highlightExtension, biasCorrection: !!options.biasCorrection,
    faceOpacity: value('inputFaceOpacity'), faceMaxLumaComplement: options.faceMaxLumaComplement ?? 1-sat(mix(value('inputFaceColorMatrixMaxLumaSDR',1),value('inputFaceColorMatrixMaxLuma',1),headroomMix)),
    face0: matrices.Face[0], face1: matrices.Face[1], face2: matrices.Face[2], bleed0: matrices.Bleed[0], bleed1: matrices.Bleed[1], bleed2: matrices.Bleed[2], shadow0: matrices.Shadow[0], shadow1: matrices.Shadow[1], shadow2: matrices.Shadow[2],
    blurFillRadius: blurRadius('inputBlurFillBlurRadius'), blurFillLighten: blurLight, blurFillDarken: blurDark, blurFillNormal: blurNormal, blurFillEnabled: options.blurFillEnabled ?? (blurLight !== 0 || blurDark !== 0 || blurNormal !== 0),
    holdingToneOpacity: options.holdingToneOpacity ?? 0, sdrShadowDistance0: dimensional('inputSDRGradientDistance0'), sdrShadowInv: options.sdrShadowInv ?? 0, sdrWhiteValue: options.sdrWhiteValue ?? 1, clampLimit: value('inputClamp'), preserveHue: !!value('inputClampPreserveHue'), edrScale: options.edrScale ?? 1,
    aberrationAmount: options.aberrationAmount ?? (finite(raw.inputAberrationAmount) ? raw.inputAberrationAmount * factor : 0), aberrationInvHeight: options.aberrationInvHeight ?? (finite(raw.inputAberrationHeight) && raw.inputAberrationHeight > 0 ? 1 / (raw.inputAberrationHeight * factor) : 0), aberrationOffset: options.aberrationOffset ?? (finite(raw.inputAberrationOffset) ? raw.inputAberrationOffset * factor : 0), aberrationDirection: vec(options.aberrationDirection || [1, 0], 2, 'aberrationDirection'),
  };
  unresolved.push('displacement matrix, extension/stroke/bias-correction flags and blur-fill gate remain caller/browser configuration unless explicitly supplied.');
  if (raw.inputAberrationAmount == null && options.aberrationAmount == null) unresolved.push('Aberration remains unresolved in raw data; browser branch explicitly disabled, raw null is unchanged.');
  unresolved.push('SDR white=1 / EDR scale=1 and disabled holding tone are browser configuration unless supplied; native HDR capture/color-space behavior unverified.');
  for (const [name, type] of Object.entries(COMPOSITE_UNIFORM_TYPES)) {
    if (type === 'float' && !finite(p[name])) throw new TypeError(`${name} is not finite`);
  }
  return { uniforms: p, provenance, unresolved };
}

const uniformCache = new WeakMap();
function bindCompositeUniforms(gl, program, params, prefix = 'u_composite') {
  const p = params.uniforms || params;
  let perPrefix = uniformCache.get(program);
  if (!perPrefix) { perPrefix = new Map(); uniformCache.set(program, perPrefix); }
  let locations = perPrefix.get(prefix);
  if (!locations) { locations = Object.fromEntries(Object.keys(COMPOSITE_UNIFORM_TYPES).map(name => [name, gl.getUniformLocation(program, `${prefix}.${name}`)])); perPrefix.set(prefix, locations); }
  for (const [name, type] of Object.entries(COMPOSITE_UNIFORM_TYPES)) {
    const location = locations[name]; if (location == null) continue;
    if (type === 'bool') gl.uniform1i(location, p[name] ? 1 : 0);
    else if (type === 'float') gl.uniform1f(location, p[name]);
    else gl[`uniform${type.slice(-1)}fv`](location, p[name]);
  }
}

const RECOVERED_COMPOSITE_GLSL = `
struct RecoveredCompositeParams {
${Object.entries(COMPOSITE_UNIFORM_TYPES).map(([name, type]) => `  ${type} ${name};`).join('\n')}
};
float rcSat(float x) { return clamp(x,0.0,1.0); }
vec3 rcClean(vec3 x) { return mix(x,vec3(0.0),lessThan(abs(x),vec3(0.000001))); }
float rcEnvelope(float d,float amount,float invHeight) {
  // module-064.ll:405-419,619-632.
  float t=rcSat(-d*invHeight); return amount*(1.0-rcSat(sqrt(t*(2.0-t))));
}
float rcLod(float r) { return max(0.0,log2(r<2.0?1.0+r*0.5:r)); }
vec2 rcPixelScale() { return vec2(textureSize(u_background,0))/u_cssSize; }
vec4 rcRead(vec2 point,float lod) { return textureLod(u_background,clamp(point/u_cssSize,vec2(0.0),vec2(1.0)),lod); }
vec4 rcSample(vec2 point,float radius) { return rcRead(point,rcLod(radius)); }
vec4 rcPlain(vec2 point,float radius) { vec4 c=rcSample(point,radius); return vec4(rcClean(c.rgb/max(c.a,0.000001)),c.a); }
vec3 rcMatrix(vec3 c,vec4 a,vec4 b,vec4 e,float contribution) {
  // module-064.ll:334-369,711-743.
  return vec3(dot(c,a.xyz),dot(c,b.xyz),dot(c,e.xyz))*contribution+vec3(a.w,b.w,e.w);
}
float rcShadowFalloff(float x) {
  // module-064.ll:278-288; decoded half coefficients, promoted float ops.
  float z=4.0*rcSat(0.25*x+0.5)-2.0,q=z*z;
  return (((0.0029544830322265625*q-0.034454345703125)*q+0.168212890625)*q-0.560546875)*z+0.5;
}
float rcBlur(float x,RecoveredCompositeParams p) {
  // module-064.ll:431-462, CPU @18B19C504..518,C7EC..808.
  if(!p.useDistanceBlur) return p.blurRadius;
  float result=p.blurAlpha.x;
  for(int i=0;i<3;++i) {
    float alpha=p.blurAlpha[i+1];if(alpha==0.0)continue;
    float width=p.blurDistance[i+1]-p.blurDistance[i];
    // Explicit browser convention for collapsed intervals, not observed GPU NaN behavior.
    float ramp=width==0.0?step(p.blurDistance[i],x):rcSat((x-p.blurDistance[i])/width);
    result-=alpha*ramp;
  }
  return p.blurRadius*result;
}
vec3 rcFace(vec3 c,RecoveredCompositeParams p) {
  // module-064.ll:684-743.
  if(p.faceMaxLumaComplement>0.0) {
    float l=dot(c,vec3(0.2126000076532364,0.7152000069618225,0.0722000002861023));
    float a=rcSat(1.0-l*p.faceMaxLumaComplement);
    c=mix(vec3(a*l),a*c,1.0+(1.0-a)*0.30000001192092896);
  }
  return rcMatrix(c,p.face0,p.face1,p.face2,1.0);
}
float rcHighlight(float d,vec2 n,float mask,float alpha,float width,RecoveredCompositeParams p) {
  // module-064.ll:78-188.
  if(p.keyHeight<=0.0) return 0.0;
  float shifted=d+p.keyEffectOffset,halfWidth=width*0.5;
  if(shifted>=halfWidth || (p.strokeMode?mask>=1.0:-shifted>=p.keyHeight+halfWidth) || alpha==0.0) return 0.0;
  float gain=1.0,band=1.0-mask;
  if(!p.strokeMode) {
    float ramp=1.0-rcSat(-shifted/p.keyHeight);
    gain=mix(ramp!=0.0?1.0:0.0,ramp,0.75);
    band=rcSat((shifted+p.keyHeight)/width+0.5);
  }
  float amp=gain*alpha*band*rcSat(-shifted/width+0.5),nd=dot(p.keyDirection,n);
  vec2 h=clamp((vec2(nd,-nd)-p.keySpread)/max(1.0-p.keySpread,0.000001),0.0,1.0)*amp;
  h/=max(vec2(1.0)+p.keyAmount*(vec2(1.0)-h),vec2(0.000001));
  return h.x+h.y;
}
float rcRing(vec2 ringSdf,float mask,RecoveredCompositeParams p) {
  // module-064.ll:192-250.
  if(p.ringOpacity<=0.0 || !(mask>0.0 || p.ringMask<1.0)) return 0.0;
  float radius=max(p.ringRadius,0.000001),x=ringSdf.x/radius;
  float falloff=rcSat(rcShadowFalloff(x*0.7071067690849304)-rcShadowFalloff((x+p.ringStrokeWidth/radius)*0.7071067690849304));
  return p.ringOpacity*ringSdf.y*falloff*mix(1.0,mask,p.ringMask);
}
float rcBleedWeight(float d,vec3 face,RecoveredCompositeParams p) {
  // module-064.ll:813-840.
  float l=rcSat(dot(face,vec3(0.21250000596046448,0.715399980545044,0.07209999859333038)));
  float x=dot(p.bleedDarken,vec2(l,1.0));
  float edge=rcSat((d-p.bleedDistance.x)/(p.bleedDistance.y-p.bleedDistance.x));
  float w=x*x*edge;return w*w*p.bleedOpacity;
}
vec3 rcSpectralTap(vec2 point,float lod) {
  vec2 delta=vec2(lod*0.25)/rcPixelScale();
  vec4 c=(rcRead(point+delta,lod)+rcRead(point-delta,lod)+rcRead(point+vec2(delta.x,-delta.y),lod)+rcRead(point+vec2(-delta.x,delta.y),lod))*0.25;
  return rcClean(c.rgb/max(c.a,0.000001));
}
vec3 rcSpectral(vec2 point,vec2 n,float d,float radius,RecoveredCompositeParams p) {
  // module-064.ll:496-530,1177-1364: opaque-source spectral adaptation.
  vec4 m=p.displacementMat;vec2 v=p.aberrationDirection;
  vec2 shift=vec2(dot(vec2(dot(m.zw,v),v.x*m.w-v.y*m.z),n),dot(vec2(dot(m.xy,v),v.x*m.y-v.y*m.x),n));
  shift*=rcEnvelope(d+p.aberrationOffset,p.aberrationAmount,p.aberrationInvHeight);
  float lod=rcLod(radius);vec3 total=vec3(0.0);
  for(int i=0;i<3;++i) { float w=1.0-float(i)/3.0;total+=rcSpectralTap(point+w*shift,lod)*vec3(w*0.5,(1.0-w)/3.0,0.0); }
  for(int i=0;i<4;++i) { float w=float(i)/3.0;total+=rcSpectralTap(point-w*shift,lod)*vec3(0.0,(1.0-w)/3.0,w*0.5); }
  return total;
}
vec4 rcFinish(vec4 result,float d,RecoveredCompositeParams p) {
  // module-064.ll:1010-1122. Premultiplied RGBA throughout.
  if(p.holdingToneOpacity>0.0) {
    float a=rcSat(result.a),w=(1.0-rcSat((d-p.sdrShadowDistance0)*p.sdrShadowInv))*p.holdingToneOpacity;
    vec4 mapped=vec4(p.sdrWhiteValue*result.rgb*a/max(result.a,0.000001),a);
    result=mix(result,mapped,w);
  }
  if(p.clampLimit>0.0) {
    vec3 c=result.rgb/max(result.a,0.000001);
    if(p.preserveHue) { float maximum=max(c.r,max(c.g,c.b));if(maximum>p.clampLimit)c*=p.clampLimit/maximum; }
    else c=clamp(c,vec3(-0.75),vec3(p.clampLimit));
    result.rgb=c*result.a;
  }
  result.rgb*=p.edrScale;return result;
}
vec4 recoveredCompositeSample(vec2 point,vec2 n,float d,float sdfAlpha,float sdfWidth,vec2 shadowSdf,vec2 ringSdf,RecoveredCompositeParams p) {
  float width=max(sdfWidth,0.0001),mask=rcSat(0.5-d/width)*sdfAlpha;
  vec2 direction=vec2(dot(n,p.displacementMat.xy),dot(n,p.displacementMat.zw));
  float highlight=rcHighlight(d,n,mask,sdfAlpha,width,p),ring=rcRing(ringSdf,mask,p);
  vec4 shadow=vec4(0.0);
  if(mask<1.0) {
    float shape=p.shadowOpacity*shadowSdf.y*rcShadowFalloff(p.shadowInvRadius*shadowSdf.x);
    if(mask==0.0 && shape<0.000001 && highlight<0.000001 && ring<0.000001)return vec4(0.0);
    if(p.shadowContribution>0.000001) {
      float shift=rcEnvelope(d+p.shadowDistanceOffset,p.shadowAmount,p.shadowInvHeight);
      vec3 c=rcMatrix(rcPlain(point+direction*shift,p.shadowBlurRadius).rgb,p.shadow0,p.shadow1,p.shadow2,p.shadowContribution);
      shadow=vec4(c,mix(p.shadowFaceOpacity,1.0,p.shadowContribution));
    } else shadow=vec4(p.shadow0.w,p.shadow1.w,p.shadow2.w,p.shadowFaceOpacity);
    shadow*=shape;
  }
  vec4 inside=vec4(0.0);
  if(mask>0.0) {
    float shift=rcEnvelope(d,p.innerAmount,p.innerInvHeight),radius=rcBlur(d+shift,p);
    vec2 center=point+direction*shift;
    vec3 c=p.aberrationAmount==0.0?rcPlain(center,radius).rgb:rcSpectral(center,n,d,radius,p);
    // module-064.ll:544-607: two-diagonal blur fill, min/max/normal blending.
    if(p.blurFillEnabled) {
      vec2 s=rcPixelScale();float lod=rcLod(p.blurFillRadius);vec2 delta=vec2(lod*0.25)/s;
      vec4 sampled=(rcRead(point+delta,lod)+rcRead(point-delta,lod))*0.5;
      vec3 fill=rcClean(sampled.rgb/max(sampled.a,0.000001));
      c=mix((1.0-p.blurFillDarken-p.blurFillLighten)*c+p.blurFillDarken*min(c,fill)+p.blurFillLighten*max(c,fill),fill,p.blurFillNormal);
    }
    inside=vec4(c,1.0);
    // module-064.ll:619-675: separate outer ray and distance blend.
    if(p.refractionOpacity>0.0) {
      float outer=rcEnvelope(d,p.outerAmount,p.outerInvHeight);
      vec4 value=rcSample(point+direction*outer,rcBlur(d+outer,p));value.rgb=rcClean(value.rgb);
      inside=mix(inside,value,p.refractionOpacity*rcSat((d-p.refractionThreshold.x)/(p.refractionThreshold.y-p.refractionThreshold.x)));
    }
    if(p.faceOpacity>0.0)inside.rgb=mix(inside.rgb,rcFace(inside.rgb,p),p.faceOpacity);
    // module-064.ll:744-862. Zero opacity skips only a provable no-op.
    if(p.bleedOpacity!=0.0) {
      float bleed=rcEnvelope(d,p.bleedAmount,p.bleedInvHeight);
      vec3 b=rcMatrix(rcPlain(point+direction*bleed,p.bleedBlurRadius).rgb,p.bleed0,p.bleed1,p.bleed2,1.0);
      inside.rgb=mix(inside.rgb,b,rcBleedWeight(d,inside.rgb,p));
    }
  }
  // module-064.ll:845-1007: premultiplied shadow/face mix, ring then highlight.
  vec4 result=mix(shadow,inside,mask)*(1.0-ring)+vec4(0.0,0.0,0.0,ring);
  if(highlight>0.000001) {
    float oldAlpha=result.a;vec3 color=result.rgb,background=vec3(0.0);
    if(oldAlpha<1.0) {
      background=rcPlain(point,0.0).rgb;vec3 adjusted=background;
      if(p.faceOpacity>0.0) {
        adjusted=rcFace(background,p);
        if(p.biasCorrection)adjusted=p.keyColorBias<0.0?min(adjusted,background):max(adjusted,background);
        adjusted=mix(background,adjusted,p.faceOpacity*highlight);
      }
      color+=(1.0-oldAlpha)*adjusted;
    }
    float alpha=oldAlpha+(1.0-oldAlpha)*highlight*(p.highlightExtension?1.0:0.0);
    color*=vec3(1.0)+p.keyColorBias*highlight*(vec3(3.0)-2.0*color);
    result=vec4(color-(1.0-alpha)*background,alpha);
  }
  return rcFinish(result,d,p);
}
`;

return {COMPOSITE_UNIFORM_TYPES,compositeEnvelope,compositeLod,compositeDistanceBlur,compositeShadowFalloff,compositeColorMatrix,compositeHighlight,compositeRingShadow,compositeBleedWeight,compositeFinish,recoveredCompositeSampleJS,roundCompositeHalf,recoveredYccColorMatrix,makeCompositeParams,bindCompositeUniforms,RECOVERED_COMPOSITE_GLSL};
})();

// core/recovered-background.js
const m5=(()=>{
/**
 * Recovered QuartzCore background-kernel arithmetic, plus an explicit WebGL2
 * adapter. Evidence: research/phase3/background-pipeline-findings.json.
 *
 * The default `tile2` pyramid ports the 2×2 equal-weight arithmetic recovered
 * from tile_downsample_2. Its repeated use, mip topology, edge handling, RGBA8
 * storage and caller-supplied offsets/weights are Web adapter choices. They are
 * NOT recovered QuartzCore scheduling or native default uniforms.
 *
 * Only explicit image/canvas/video or texture sources are accepted. This module
 * cannot turn arbitrary DOM or the desktop into a live backdrop texture.
 */

const RECOVERED_BACKGROUND_KERNELS = Object.freeze({
  copy: { taps: 1, evidence: 'Web adapter copy' },
  tile2: { taps: 4, evidence: 'module-120 tile_downsample_2: four 1/4 imageblock values' },
  downsample4: { taps: 4, offsets: 4, weights: 4, evidence: 'module-020; caller uniforms' },
  downsample6: { taps: 6, offsets: 3, weights: 3, evidence: 'module-022; symmetric pairs' },
  downsample8: { taps: 16, offsets: 4, weights: 0, evidence: 'module-021; four quadrants × 1/16' },
  blur2: { taps: 7, offsets: 3, weights: 4, evidence: 'module-026; center and three pairs' },
  blur4: { taps: 13, offsets: 6, weights: 7, evidence: 'module-027; center and six pairs' },
  variable13: { taps: 13, evidence: 'module-110/111; fixed half-valued diamond stencil, dst_dx/dst_dy spacing' },
});

const RECOVERED_VARIABLE13 = Object.freeze({
  center: .10546875, axial1: .0902099609375, diagonal1: .07708740234375,
  axial2: .05633544921875, rgbZeroThreshold: .00010001659393310547,
  weightSum: 1,
});

function validateKernel(kernel, offsets = [], weights = []) {
  const spec = RECOVERED_BACKGROUND_KERNELS[kernel];
  if (!spec) throw new RangeError(`Unknown background kernel: ${kernel}`);
  if (offsets.length < (spec.offsets || 0) || weights.length < (spec.weights || 0)) {
    throw new RangeError(`${kernel} needs ${spec.offsets || 0} UV offsets and ${spec.weights || 0} weights; no native defaults are assumed`);
  }
  return spec;
}

/** Exact tap topology; numbers supplied by a caller are never relabeled defaults. */
function recoveredBackgroundTaps(kernel, offsets = [], weights = []) {
  validateKernel(kernel, offsets, weights);
  const taps = [];
  const add = (offset, weight) => taps.push({ offset: [...offset], weight });
  if (kernel === 'copy') add([0, 0], 1);
  else if (kernel === 'tile2') throw new TypeError('tile2 uses integer imageblock positions; use recoveredBackgroundReference');
  else if (kernel === 'variable13') {
    if (!offsets[0]) throw new RangeError('variable13 taps need [dst_dx,dst_dy] in offsets[0]');
    const [dx, dy] = offsets[0];
    add([0, 0], RECOVERED_VARIABLE13.center);
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) add([x * dx, y * dy], RECOVERED_VARIABLE13.axial1);
    for (const [x, y] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) add([x * dx, y * dy], RECOVERED_VARIABLE13.diagonal1);
    for (const [x, y] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) add([x * dx, y * dy], RECOVERED_VARIABLE13.axial2);
  }
  else if (kernel === 'downsample4') for (let i = 0; i < 4; i++) add(offsets[i], weights[i]);
  else if (kernel === 'downsample8') {
    // Order follows the original fragment's quadrant groups.
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (let i = 0; i < 4; i++) add([sx * offsets[i][0], sy * offsets[i][1]], 1 / 16);
    }
  } else {
    const n = kernel === 'blur4' ? 6 : 3;
    if (kernel.startsWith('blur')) add([0, 0], weights[0]);
    for (let i = 0; i < n; i++) {
      const w = weights[i + (kernel.startsWith('blur') ? 1 : 0)];
      add(offsets[i], w); add(offsets[i].map(v => -v), w);
    }
  }
  return taps;
}

/** CPU reference: normalized bilinear clamp-to-edge, float64 accumulation.
 * Input/output use row 0 at UV y=0; edrScale affects RGB only, as in the AIR.
 * Half rounding, native fast math and GPU sampling precision are not emulated.
 */
function recoveredBackgroundReference({ data, width, height }, {
  width: outputWidth, height: outputHeight, kernel = 'tile2', offsets = [], weights = [], edrScale = 1,
}) {
  validateKernel(kernel, offsets, weights);
  const output = new Float32Array(outputWidth * outputHeight * 4);
  const pixel = (x, y, c) => data[(Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4 + c];
  const sample = (u, v, c) => {
    const x = u * width - .5, y = v * height - .5;
    const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
    return (pixel(ix, iy, c) * (1 - tx) + pixel(ix + 1, iy, c) * tx) * (1 - ty)
      + (pixel(ix, iy + 1, c) * (1 - tx) + pixel(ix + 1, iy + 1, c) * tx) * ty;
  };
  const actualOffsets = kernel === 'variable13' && !offsets.length ? [[1 / outputWidth, 1 / outputHeight]] : offsets;
  const taps = kernel === 'tile2' ? null : recoveredBackgroundTaps(kernel, actualOffsets, weights);
  for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) for (let c = 0; c < 4; c++) {
    let sum = 0;
    if (kernel === 'tile2') {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += pixel(x * 2 + dx, y * 2 + dy, c) * .25;
    } else for (const t of taps) sum += sample((x + .5) / outputWidth + t.offset[0], (y + .5) / outputHeight + t.offset[1], c) * t.weight;
    if (kernel === 'variable13' && c < 3 && Math.abs(sum) < RECOVERED_VARIABLE13.rgbZeroThreshold) sum = 0;
    output[(y * outputWidth + x) * 4 + c] = sum * (c < 3 ? edrScale : 1);
  }
  return { data: output, width: outputWidth, height: outputHeight };
}

const VS = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_outputSize;
uniform vec2 u_offsets[8];
uniform float u_weights[8];
uniform float u_edrScale;
uniform int u_kernel;
out vec4 outColor;
vec4 at(vec2 p){return textureLod(u_source,p,0.);}
void main(){
  vec2 uv=gl_FragCoord.xy/u_outputSize;
  vec4 s=vec4(0);
  if(u_kernel==0){s=at(uv);}
  else if(u_kernel==1){
    ivec2 p=ivec2(gl_FragCoord.xy)*2, hi=textureSize(u_source,0)-1;
    s=(texelFetch(u_source,min(p,hi),0)+texelFetch(u_source,min(p+ivec2(1,0),hi),0)
      +texelFetch(u_source,min(p+ivec2(0,1),hi),0)+texelFetch(u_source,min(p+ivec2(1),hi),0))*.25;
  }else if(u_kernel==7){
    vec2 d=u_offsets[0];s=at(uv)*.10546875;
    s+=(at(uv+vec2(d.x,0))+at(uv-vec2(d.x,0))+at(uv+vec2(0,d.y))+at(uv-vec2(0,d.y)))*.0902099609375;
    s+=(at(uv+d)+at(uv-d)+at(uv+vec2(d.x,-d.y))+at(uv+vec2(-d.x,d.y)))*.07708740234375;
    s+=(at(uv+vec2(2.*d.x,0))+at(uv-vec2(2.*d.x,0))+at(uv+vec2(0,2.*d.y))+at(uv-vec2(0,2.*d.y)))*.05633544921875;
    s.rgb=vec3(abs(s.r)<.00010001659393310547?0.:s.r,abs(s.g)<.00010001659393310547?0.:s.g,abs(s.b)<.00010001659393310547?0.:s.b);
  }else if(u_kernel==2){for(int i=0;i<4;i++)s+=at(uv+u_offsets[i])*u_weights[i];}
  else if(u_kernel==4){
    for(int q=0;q<4;q++){vec2 signUV=vec2(q<2?1.:-1.,(q%2)==0?1.:-1.);
      for(int i=0;i<4;i++)s+=at(uv+u_offsets[i]*signUV)*.0625;}
  }else{
    int n=u_kernel==6?6:3;bool center=u_kernel>=5;
    if(center)s=at(uv)*u_weights[0];
    for(int i=0;i<6;i++){if(i>=n)break;s+=(at(uv+u_offsets[i])+at(uv-u_offsets[i]))*u_weights[i+(center?1:0)];}
  }
  outColor=vec4(s.rgb*u_edrScale,s.a);
}`;
const KERNEL_ID = { copy: 0, tile2: 1, downsample4: 2, downsample6: 3, downsample8: 4, blur2: 5, blur4: 6, variable13: 7 };

function compile(gl, type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(log); }
  return shader;
}

/** Reusable processor. `run` returns a single-level texture. `buildPyramid`
 * returns one complete mip texture compatible with textureLod in the optics.
 * Each step may explicitly override kernel/offsets/weights/edrScale.
 */
function createRecoveredBackground(gl) {
  if (!gl || typeof gl.texStorage2D !== 'function') throw new TypeError('WebGL2 context required');
  const vs = compile(gl, gl.VERTEX_SHADER, VS), fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const vao = gl.createVertexArray(), framebuffer = gl.createFramebuffer();
  const linearSampler = gl.createSampler();
  gl.samplerParameteri(linearSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.samplerParameteri(linearSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.samplerParameteri(linearSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(linearSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const locations = Object.fromEntries(['source', 'outputSize', 'offsets[0]', 'weights[0]', 'edrScale', 'kernel'].map(n => [n, gl.getUniformLocation(program, `u_${n}`)]));
  let disposed = false;
  function transaction(fn) {
    if (disposed) throw new Error('Recovered background processor disposed');
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0); const tex = gl.getParameter(gl.TEXTURE_BINDING_2D), sampler = gl.getParameter(gl.SAMPLER_BINDING);
    const saved = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT), mask: gl.getParameter(gl.COLOR_WRITEMASK),
      enables: [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD, gl.DITHER].map(c => [c, gl.isEnabled(c)]) };
    try { gl.bindSampler(0, linearSampler); saved.enables.forEach(([c]) => gl.disable(c)); gl.colorMask(true, true, true, true); return fn(); }
    finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
      gl.viewport(...saved.viewport); gl.colorMask(...saved.mask); saved.enables.forEach(([c, v]) => v ? gl.enable(c) : gl.disable(c));
      gl.useProgram(saved.program); gl.bindVertexArray(saved.vao); gl.bindTexture(gl.TEXTURE_2D, tex); gl.bindSampler(0, sampler); gl.activeTexture(active);
    }
  }
  function allocate(width, height, levels = 1) {
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  function execute(source, options) {
    const { width, height, kernel = 'tile2', offsets = [], weights = [], edrScale = 1 } = options;
    validateKernel(kernel, offsets, weights);
    if (!(width > 0 && height > 0 && Number.isInteger(width) && Number.isInteger(height))) throw new RangeError('Positive integer output dimensions required');
    const texture = allocate(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.deleteTexture(texture); throw new Error('Background framebuffer incomplete'); }
    gl.viewport(0, 0, width, height); gl.useProgram(program); gl.bindVertexArray(vao);
    gl.bindTexture(gl.TEXTURE_2D, source.texture); gl.uniform1i(locations.source, 0);
    gl.uniform2f(locations.outputSize, width, height); gl.uniform1i(locations.kernel, KERNEL_ID[kernel]); gl.uniform1f(locations.edrScale, edrScale);
    const o = new Float32Array(16), w = new Float32Array(8);
    const actualOffsets = kernel === 'variable13' && !offsets.length ? [[1 / width, 1 / height]] : offsets;
    actualOffsets.slice(0, 8).forEach((v, i) => o.set(v, i * 2)); w.set(weights.slice(0, 8));
    gl.uniform2fv(locations['offsets[0]'], o); gl.uniform1fv(locations['weights[0]'], w); gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { texture, width, height, levels: 1, kernel, dispose() { gl.deleteTexture(texture); } };
  }
  function getSource(source, options) {
    if (source.texture) return { ...source, owned: false };
    const width = options.width || source.videoWidth || source.naturalWidth || source.width;
    const height = options.height || source.videoHeight || source.naturalHeight || source.height;
    if (!(width > 0 && height > 0)) throw new TypeError('Source dimensions required');
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } finally { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply); }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { texture, width, height, owned: true };
  }
  return {
    run(source, options) { return transaction(() => execute(source, options)); },
    buildPyramid(source, options = {}) { return transaction(() => {
      const input = getSource(source, options);
      if (options.maxLevels !== undefined && !(Number.isInteger(options.maxLevels) && options.maxLevels > 0)) throw new RangeError('maxLevels must be a positive integer');
      const count = Math.min(1 + Math.floor(Math.log2(Math.max(input.width, input.height))), options.maxLevels ?? Infinity);
      const texture = allocate(input.width, input.height, count), sizes = [], steps = [];
      let previous = input;
      try {
        for (let level = 0; level < count; level++) {
          const width = Math.max(1, input.width >> level), height = Math.max(1, input.height >> level);
          const step = level === 0 ? { kernel: 'copy' } : { kernel: options.kernel || 'tile2', ...(options.steps?.[level - 1] || {}) };
          const current = execute(previous, { ...step, width, height });
          gl.bindTexture(gl.TEXTURE_2D, texture); gl.copyTexSubImage2D(gl.TEXTURE_2D, level, 0, 0, 0, 0, width, height);
          if (previous !== input) previous.dispose(); previous = current;
          sizes.push([width, height]); steps.push({ level, ...step });
        }
      } catch (error) { gl.deleteTexture(texture); throw error; }
      finally { if (previous !== input) previous.dispose(); if (input.owned) gl.deleteTexture(input.texture); }
      return { texture, width: input.width, height: input.height, levels: count, sizes, steps, format: 'RGBA8',
        provenance: 'Recovered kernel arithmetic; explicit Web mip schedule, storage, border and input adaptation', dispose() { gl.deleteTexture(texture); } };
    }); },
    dispose() { if (!disposed) { gl.deleteProgram(program); gl.deleteFramebuffer(framebuffer); gl.deleteVertexArray(vao); gl.deleteSampler(linearSampler); disposed = true; } },
  };
}

return {RECOVERED_BACKGROUND_KERNELS,RECOVERED_VARIABLE13,recoveredBackgroundTaps,recoveredBackgroundReference,createRecoveredBackground};
})();

// core/recovered-sdf-highlight.js
const m6=(()=>{
/**
 * Instruction-derived CASDF key/fill shader arithmetic, separate from the
 * glassBackground filter. Source: original QuartzCore AIR module-239.ll,
 * fixed_frag_lpf_cpf, sdf_key_fill_highlight lines7114–7217 and
 * sdf_diffuse_kf_highlight lines6938–7099; metadata11081–11091.
 *
 * Inputs here are EXPANDED SHADER parameters, not Objective-C property values.
 * The optional raw factory follows separately recovered CASDF CPU lowering;
 * gradient basis and per-draw flags still require explicit caller inputs.
 * In particular neither direction nor
 * amountShape is assumed to equal the similarly named glassBackground field.
 * All distances/height/offset must share the native SDF coordinate units.
 * Colors must already be native-compatible premultiplied RGBA.
 *
 * Native discard is represented by transparent zero so callers can composite
 * this independent layer without discarding their already-computed backdrop.
 * The helpers DO NOT multiply by sdf.a; that omission is actual AIR behavior.
 * A nonzero SDF gradient is required; native fast-math has no zero-length guard.
 */

const {roundCompositeHalf}=m4;
const EPS = 1e-6;
const MIN_WIDTH = 1e-4;
const sat = value => Math.min(1, Math.max(0, value));
const mix = (a, b, t) => a + (b - a) * t;
const vec4 = (value, label) => {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
    throw new TypeError(`${label} must contain four finite expanded shader values`);
  }
  return value;
};

const SDF_HIGHLIGHT_PACKED_LAYOUT = Object.freeze({
  uniformBufferIndex: 1,
  uniformBufferBytes: 384,
  unionOffsetBytes: 272,
  keyFill: Object.freeze({ textureFunction: 67, paramsOffsets: Object.freeze([272, 288, 304, 320]), colorOffsets: Object.freeze([336, 352]) }),
  diffuse: Object.freeze({ textureFunction: 68, paramsOffsets: Object.freeze([272, 288, 304, 320, 336]), colorOffsets: Object.freeze([352, 368]) }),
});

const RECOVERED_SDF_HIGHLIGHT_GLSL = /* glsl */ `
// Original AIR module239:6938–7216. All p-fields are expanded shader inputs.
struct RecoveredSdfHighlightParams {
  vec4 p0; // height0,spreadCos0,amountShape0,dir0.x
  vec4 p1; // dir0.y,height1,spreadCos1,amountShape1
  vec4 p2; // dir1.xy(key-only),curvature,effectOffset
  vec4 p3; // key:global,...; diffuse:height0,spread0,amount0,height1
  vec4 p4; // diffuse:spread1,amount1,global,unused
  vec4 color0;
  vec4 color1;
};
float rsdhBand(float inward, float height, float curvature, float width) {
  float t=clamp(inward/height,0.0,1.0);
  float gain=mix(t<1.0?1.0:0.0,1.0-t,curvature);
  return gain*clamp(inward/width+0.5,0.0,1.0)*clamp((height-inward)/width+0.5,0.0,1.0);
}
float rsdhDirection(float nd,float spread) {
  return clamp((nd-spread)/max(1.0-spread,0.000001),0.0,1.0);
}
float rsdhShape(float weight,float amountShape) {
  return weight/max(1.0+amountShape*(1.0-weight),0.000001);
}
vec4 recoveredSdfKeyFillHighlight(vec4 sdf,RecoveredSdfHighlightParams p) {
  float invLength=inversesqrt(dot(sdf.yz,sdf.yz));
  vec2 n=sdf.yz*invLength;
  float inward=-(sdf.x+p.p2.w)*(p.p3.x!=0.0?invLength:1.0);
  float width=max(fwidth(inward),0.0001);
  float h0=rsdhBand(inward,p.p0.x,p.p2.z,width)*rsdhDirection(dot(n,vec2(p.p0.w,p.p1.x)),p.p0.y);
  float h1=rsdhBand(inward,p.p1.y,p.p2.z,width)*rsdhDirection(dot(n,p.p2.xy),p.p1.z);
  if(inward < -5.0 || h0+h1 < 0.000001) return vec4(0.0);
  return rsdhShape(h0,p.p0.z)*p.color0+rsdhShape(h1,p.p1.w)*p.color1;
}
vec4 recoveredSdfDiffuseKeyFillHighlight(vec4 sdf,RecoveredSdfHighlightParams p) {
  float invLength=inversesqrt(dot(sdf.yz,sdf.yz));
  vec2 n=sdf.yz*invLength;
  float inward=-(sdf.x+p.p2.w)*(p.p4.z!=0.0?invLength:1.0);
  float width=max(fwidth(inward),0.0001);
  float nd=dot(n,vec2(p.p0.w,p.p1.x));
  // Diffuse specialization uses -nd for fill and ignores p2.xy.
  float h0=rsdhBand(inward,p.p0.x,p.p2.z,width)*rsdhDirection(nd,p.p0.y);
  float h1=rsdhBand(inward,p.p1.y,p.p2.z,width)*rsdhDirection(-nd,p.p1.z);
  // Diffuse bands always use the linear radial falloff (curvature=1).
  float hd0=rsdhBand(inward,p.p3.x,1.0,width)*rsdhDirection(nd,p.p3.y);
  float hd1=rsdhBand(inward,p.p3.w,1.0,width)*rsdhDirection(-nd,p.p4.x);
  if(inward < -5.0 || h0+h1+hd0+hd1 < 0.000001) return vec4(0.0);
  return (rsdhShape(h0,p.p0.z)+rsdhShape(hd0,p.p3.z))*p.color0
       +(rsdhShape(h1,p.p1.w)+rsdhShape(hd1,p.p4.y))*p.color1;
}
`;

/** Raw arithmetic for the already shifted/optionally gradient-scaled distance. */
function sdfHighlightBandJS(inward, height, curvature, width) {
  const t = sat(inward / height);
  return mix(t < 1 ? 1 : 0, 1 - t, curvature)
    * sat(inward / Math.max(width, MIN_WIDTH) + .5)
    * sat((height - inward) / Math.max(width, MIN_WIDTH) + .5);
}

/**
 * width is fwidth(-(sdf.x+effectOffset)*globalGradientScale), not an
 * independently guessed pixel ratio. Native shader computes it per quad.
 */
function sdfHighlightDetailsJS({ sdf, params, colors, width, diffuse = false }) {
  vec4(sdf, 'sdf');
  if (!Number.isFinite(width) || width < 0) throw new TypeError('width must be the finite nonnegative shifted-distance fwidth');
  if (!Array.isArray(params) || params.length !== (diffuse ? 5 : 4)) throw new TypeError('Expected four key/fill or five diffuse parameter vectors');
  params.forEach((value, index) => vec4(value, `params[${index}]`));
  if (!Array.isArray(colors) || colors.length !== 2) throw new TypeError('Expected two premultiplied RGBA colors');
  colors.forEach((value, index) => vec4(value, `colors[${index}]`));
  const [p0, p1, p2, p3, p4] = params;
  const length = Math.hypot(sdf[1], sdf[2]);
  if (length === 0) throw new RangeError('Native SDF highlight requires a nonzero gradient; no native zero-gradient guard was recovered');
  const n = [sdf[1] / length, sdf[2] / length];
  const inward = -(sdf[0] + p2[3]) * ((diffuse ? p4[2] : p3[0]) !== 0 ? 1 / length : 1);
  const w = Math.max(width, MIN_WIDTH);
  const direction = (nd, spread) => sat((nd - spread) / Math.max(1 - spread, EPS));
  const shape = (h, amount) => h / Math.max(1 + amount * (1 - h), EPS);
  const nd = n[0] * p0[3] + n[1] * p1[0];
  const fillDot = diffuse ? -nd : n[0] * p2[0] + n[1] * p2[1];
  const h0 = sdfHighlightBandJS(inward, p0[0], p2[2], w) * direction(nd, p0[1]);
  const h1 = sdfHighlightBandJS(inward, p1[1], p2[2], w) * direction(fillDot, p1[2]);
  const hd0 = diffuse ? sdfHighlightBandJS(inward, p3[0], 1, w) * direction(nd, p3[1]) : 0;
  const hd1 = diffuse ? sdfHighlightBandJS(inward, p3[3], 1, w) * direction(-nd, p4[0]) : 0;
  const discarded = inward < -5 || h0 + h1 + hd0 + hd1 < EPS;
  const keyWeight = discarded ? 0 : shape(h0, p0[2]) + (diffuse ? shape(hd0, p3[2]) : 0);
  const fillWeight = discarded ? 0 : shape(h1, p1[3]) + (diffuse ? shape(hd1, p4[1]) : 0);
  const rgba = colors[0].map((value, index) => value * keyWeight + colors[1][index] * fillWeight);
  return { rgba, inward, normal: n, width: w, rawWeights: [h0, h1, hd0, hd1], keyWeight, fillWeight, discarded };
}

function sdfHighlightSampleJS(options) { return sdfHighlightDetailsJS(options).rgba; }

/** Validate explicit packed inputs without inventing any native lowering. */
function makePackedSdfHighlightParams({ params, colors, diffuse = false, provenance = {} }) {
  // Validate via a nondegenerate arithmetic evaluation; retain caller's units.
  sdfHighlightDetailsJS({ sdf: [-.25, 1, 0, 1], params, colors, width: 1, diffuse });
  const copied = params.map(value => Object.freeze([...value]));
  while (copied.length < 5) copied.push(Object.freeze([0, 0, 0, 0]));
  const uniforms = Object.freeze(Object.fromEntries([
    ...copied.map((value, index) => [`p${index}`, value]),
    ['color0', Object.freeze([...colors[0]])], ['color1', Object.freeze([...colors[1]])],
  ]));
  return Object.freeze({ uniforms, diffuse, provenance: Object.freeze({
    parameterLevel: 'explicit expanded shader values; not raw Objective-C properties',
    cpuPackingRecovered: false, ...provenance,
  }) });
}

/**
 * CPU evidence: research/phase3/sdf-highlight-cpu-disassembly.txt,
 * SDFNode::apply -> emit_sdf_key_fill_highlight_simple.
 * Amount-shape is 1/amount-2 (raw .5 maps to0), not the raw amount.
 * This factory covers the observed global=0 property path only. A true global
 * input triggers additional context overrides that are intentionally rejected.
 * normalScaleFlag is a separate render-layer metadata bit test, NOT raw.global.
 * Native missing metadata chooses flag1; the actual live metadata is unobserved.
 * Callers must select an explicit flag and coordinate adaptation.
 */
function makeSdfHighlightFromRaw(raw, options = {}) {
  const { diffuse = true, effectOffset, normalScaleFlag, rawToSdf = 1,
    nodeOpacity = 1, renderColors, quantizeHalf = false } = options;
  if (raw.global !== 0 && raw.global !== false) throw new RangeError('Only the observed global=0 CASDF property path has been lowered');
  if (!Number.isFinite(effectOffset)) throw new TypeError('Provide the captured CASDFLayer.effectOffset');
  if (normalScaleFlag !== 0 && normalScaleFlag !== 1) throw new TypeError('Provide the independent per-draw normalScaleFlag (0 or1), not raw.global');
  if (!Number.isFinite(rawToSdf) || rawToSdf <= 0 || !Number.isFinite(nodeOpacity)) throw new TypeError('rawToSdf must be positive and nodeOpacity finite');
  const read = key => {
    if (!Number.isFinite(raw[key])) throw new TypeError(`Missing finite CASDF input ${key}`);
    return Math.fround(raw[key]);
  };
  const f = Math.fround;
  const angle = key => {
    const a = read(key);
    return [f(Math.sin(a)), f(-Math.cos(a))];
  };
  const height = stem => f(f(read(`${stem}Height`) * read(`${stem}HeightScale`)) + read(`${stem}HeightOffset`));
  const spread = stem => f(f(read(`${stem}Spread`) * read(`${stem}SpreadScale`)) + read(`${stem}SpreadOffset`));
  const shape = value => {
    if (!(value > 0)) throw new RangeError('Zero or negative native amount is a singular boundary; provide explicit packed parameters to investigate it');
    return f(f(1 / value) - 2);
  };
  const [kx, ky] = angle('keyAngle'), [fx, fy] = angle('fillAngle');
  const kh = height('key'), fh = height('fill');
  const ks = spread('key'), fs = spread('fill');
  const ka = read('keyAmount'), fa = read('fillAmount');
  const params = [
    [f(kh * rawToSdf), f(Math.cos(ks)), shape(ka), kx],
    [ky, f(fh * rawToSdf), f(Math.cos(fs)), shape(fa)],
    [fx, fy, read('curvature'), f(effectOffset * rawToSdf)],
  ];
  if (diffuse) {
    // This combined specialization assumes antipodal fill, as the AIR uses -nd.
    // The live pair 0/pi satisfies the CPU antipodal branch tolerance; this
    // adapter rejects visibly different pairs instead of silently discarding it.
    if (Math.abs(kx + fx) > 9.999999747378752e-5 || Math.abs(ky + fy) > 9.999999747378752e-5) {
      throw new RangeError('Combined diffuse helper requires antipodal key/fill directions; native non-antipodal dispatch uses two simple passes');
    }
    const hs = read('diffuseHeightScale'), ss = read('diffuseSpreadScale'), as = read('diffuseAmountScale');
    params.push([f(f(kh * hs) * rawToSdf), f(Math.cos(f(ks * ss))), shape(f(ka * as)), f(f(fh * hs) * rawToSdf)]);
    params.push([f(Math.cos(f(fs * ss))), shape(f(fa * as)), normalScaleFlag, 0]);
  } else params.push([normalScaleFlag, 0, 0, 0]);
  const white = color => color?.components?.length === 4 && color.components.every(value => value === 1);
  let colors = renderColors;
  if (!colors) {
    if (!white(raw.keyColor) || !white(raw.fillColor)) throw new TypeError('Nonwhite CGColor-to-Render matching is not recovered; provide explicit renderColors');
    colors = [[1, 1, 1, 1], [1, 1, 1, 1]];
  }
  colors = colors.map((value, index) => vec4(value, `renderColors[${index}]`).map(channel => f(channel * nodeOpacity)));
  const uploadedParams = quantizeHalf ? params.map(value => value.map(roundCompositeHalf)) : params;
  const uploadedColors = quantizeHalf ? colors.map(value => value.map(roundCompositeHalf)) : colors;
  return makePackedSdfHighlightParams({ params: uploadedParams, colors: uploadedColors, diffuse, provenance: {
    parameterLevel: 'CPU instruction-derived scalar lowering with explicit draw flags and coordinate adapter',
    nativeScalarPackingRecovered: true,
    cpuPackingRecovered: false,
    colorLowering: renderColors ? 'caller supplies Render premultiplied color' : 'captured opaque white with explicit identity node-color-multiplier adapter; native matching shortcut is conditional',
    nativeNodeColorMultiplierObserved: false,
    uploadQuantization: quantizeHalf ? 'explicit binary16 candidate from native encoder descriptor; live shader variant not observed' : 'CPU float32 staging values; not a claim about native final GPU buffer format',
    rawToSdf, nodeOpacity,
    normalScaleFlag, normalScaleFlagObservedInNativeDraw: false,
    diffuseDispatch: diffuse ? 'caller selects merged antipodal diffuse branch' : 'caller selects simple branch',
    precision: 'JavaScript Math trig rounded tofloat32; native sincosf/cosf and FMA may differ by last bits',
  } });
}

const locations = new WeakMap();
function bindSdfHighlightUniforms(gl, program, packed, prefix = 'u_sdfHighlight') {
  let programLocations = locations.get(program);
  if (!programLocations) { programLocations = new Map(); locations.set(program, programLocations); }
  for (const [key, value] of Object.entries(packed.uniforms ?? packed)) {
    const name = `${prefix}.${key}`;
    if (!programLocations.has(name)) programLocations.set(name, gl.getUniformLocation(program, name));
    const location = programLocations.get(name);
    if (location !== null) gl.uniform4fv(location, value);
  }
}

const freezeRaw = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeRaw); Object.freeze(value); }
  return value;
};
/** Exact live Clear active Aqua sample; active DarkAqua sample separately matches it. No inactive/Regular extrapolation. */
const CLEAR_V5_SDF_HIGHLIGHT_RAW = freezeRaw({
  "curvature": 0.75,
  "diffuseAmountScale": 0.15000000596046448,
  "diffuseHeightScale": 8,
  "diffuseSpreadScale": 0.6499999761581421,
  "fillAmount": 0.5,
  "fillAngle": 3.141592653589793,
  "fillColor": {
    "colorSpace": "kCGColorSpaceExtendedSRGB",
    "components": [
      1,
      1,
      1,
      1
    ]
  },
  "fillHeight": 1,
  "fillHeightOffset": 0,
  "fillHeightScale": 1,
  "fillSpread": 1.5707963267948966,
  "fillSpreadOffset": 0,
  "fillSpreadScale": 1,
  "global": 0,
  "keyAmount": 0.5,
  "keyAngle": 0,
  "keyColor": {
    "colorSpace": "kCGColorSpaceExtendedSRGB",
    "components": [
      1,
      1,
      1,
      1
    ]
  },
  "keyHeight": 1,
  "keyHeightOffset": 0,
  "keyHeightScale": 1,
  "keySpread": 1.5707963267948966,
  "keySpreadOffset": 0,
  "keySpreadScale": 1
});
const CLEAR_V5_SDF_HIGHLIGHT_SOURCE = Object.freeze({
  "path": "research/phase3/native-v5-sdf-highlight.json",
  "sha256": "9a8c4c6e762ccfc0b514c76884c5d635bfa0b473eb286620975a395383440924",
  "class": "CASDFKeyFillHighlightEffect",
  "layer": "layer-0210",
  "scope": "the captured active Clear Aqua sample; DarkAqua equality established by separate captured sample, not every appearance/state"
});

return {SDF_HIGHLIGHT_PACKED_LAYOUT,RECOVERED_SDF_HIGHLIGHT_GLSL,sdfHighlightBandJS,sdfHighlightDetailsJS,sdfHighlightSampleJS,makePackedSdfHighlightParams,makeSdfHighlightFromRaw,bindSdfHighlightUniforms,CLEAR_V5_SDF_HIGHLIGHT_RAW,CLEAR_V5_SDF_HIGHLIGHT_SOURCE};
})();

// core/recovered-vibrancy.js
const m7=(()=>{
/**
 * Masked backdrop color transformation from QuartzCore fixed_frag_lpf_cpf AIR,
 * module-239.ll:7658-7770 (vibrant_color_matrix). The companion *_sover helper
 * at 6138-6243 adds the transformed mask over the supplied backdrop.
 *
 * This is a separate pass from glass_background_all_lpf. It transforms the
 * backdrop under an SDF alpha mask; applying this matrix to white highlight RGB
 * would implement a different operation. Caller color space / clamp packing and
 * the actual render-server intermediate remain separate calibration questions.
 */
const CLEAR_V5_VIBRANCY = Object.freeze({
  source: 'research/phase3/native-v5-sdf-highlight.json',
  scope: 'Only the sampled active NSGlassEffectView Clear, Aqua and DarkAqua',
  rows: Object.freeze([
    1.3191999197006226, -.04779999703168869, -.004699999932199717, 0, .19999998807907104,
    -.0142000000923872, 1.285599946975708, -.004799999762326479, 0, .19999998807907104,
    -.0142000000923872, -.047599997371435165, 1.3284999132156372, 0, .19999998807907104,
    0, 0, 0, 1, 0
  ])
});

const RECOVERED_VIBRANCY_GLSL = `
struct RecoveredVibrancyParams {
  vec4 row0; vec4 row1; vec4 row2; vec4 row3; vec4 bias;
  float clampLimit; float preserveHue;
};
vec4 recoveredVibrantMask(vec4 mask, vec4 backdrop, RecoveredVibrancyParams p) {
  vec4 color = vec4(backdrop.rgb / max(backdrop.a, 1e-6), backdrop.a);
  vec4 mapped = vec4(dot(p.row0,color),dot(p.row1,color),
                     dot(p.row2,color),dot(p.row3,color)) + p.bias;
  mapped.a = clamp(mapped.a,0.,1.);
  mapped.rgb *= mapped.a;
  mapped *= mask.a;
  if(p.clampLimit > 0.) {
    vec3 straight = mapped.rgb / max(mapped.a,1e-6);
    if(p.preserveHue > 0.) {
      float highest=max(max(straight.r,straight.g),straight.b);
      if(highest > p.clampLimit) straight *= p.clampLimit / highest;
    } else straight=clamp(straight,vec3(-.75),vec3(p.clampLimit));
    mapped.rgb=straight*mapped.a;
  }
  return mapped;
}
vec4 recoveredVibrantOver(vec4 mask,vec4 backdrop,RecoveredVibrancyParams p) {
  vec4 layer=recoveredVibrantMask(mask,backdrop,p);
  return layer+backdrop*(1.-layer.a);
}`;

function makeVibrancyParams(rows, {clampLimit=1,preserveHue=false}={}) {
  if(rows.length!==20||!rows.every(Number.isFinite)) throw new TypeError('Expected four finite five-component matrix rows');
  return {row0:rows.slice(0,4),row1:rows.slice(5,9),row2:rows.slice(10,14),row3:rows.slice(15,19),
    bias:[rows[4],rows[9],rows[14],rows[19]],clampLimit,preserveHue:preserveHue?1:0};
}

function bindVibrancyUniforms(gl, program, params, prefix='u_vibrancy') {
  for(const key of ['row0','row1','row2','row3','bias'])gl.uniform4fv(gl.getUniformLocation(program,`${prefix}.${key}`),params[key]);
  for(const key of ['clampLimit','preserveHue'])gl.uniform1f(gl.getUniformLocation(program,`${prefix}.${key}`),params[key]);
}

function vibrantMaskSampleJS({mask,backdrop,rows,clampLimit=1,preserveHue=false}) {
  const p=makeVibrancyParams(rows,{clampLimit,preserveHue}),eps=1e-6;
  const c=[...backdrop.slice(0,3).map(v=>v/Math.max(backdrop[3],eps)),backdrop[3]];
  const mapped=['row0','row1','row2','row3'].map((key,i)=>p[key].reduce((sum,v,j)=>sum+v*c[j],p.bias[i]));
  mapped[3]=Math.min(1,Math.max(0,mapped[3]));
  for(let i=0;i<3;i++)mapped[i]*=mapped[3];
  for(let i=0;i<4;i++)mapped[i]*=mask[3];
  if(clampLimit>0){let straight=mapped.slice(0,3).map(v=>v/Math.max(mapped[3],eps));
    if(preserveHue){const high=Math.max(...straight);if(high>clampLimit)straight=straight.map(v=>v*clampLimit/high);}
    else straight=straight.map(v=>Math.min(clampLimit,Math.max(-.75,v)));
    for(let i=0;i<3;i++)mapped[i]=straight[i]*mapped[3];
  }
  return mapped;
}

return {CLEAR_V5_VIBRANCY,RECOVERED_VIBRANCY_GLSL,makeVibrancyParams,bindVibrancyUniforms,vibrantMaskSampleJS};
})();

// core/glass-renderer.js
const m2=(()=>{
const {RECOVERED_OPTICS_GLSL}=m3;
const {RECOVERED_COMPOSITE_GLSL, bindCompositeUniforms}=m4;
const {createRecoveredBackground}=m5;
const {RECOVERED_SDF_HIGHLIGHT_GLSL, bindSdfHighlightUniforms}=m6;
const {RECOVERED_VIBRANCY_GLSL, bindVibrancyUniforms}=m7;
/**
 * A partial WebGL reconstruction of a liquid-glass material. The recovered
 * optical and composition helpers follow decoded system AIR, with CPU parameter
 * lowering and independent Metal/WebGL checks. Actual UI pass selection, SDF
 * geometry, background mip scheduling and runtime scale mapping remain partial;
 * the demo also applies an explicit styling tint. The fitted path is independent.
 *
 * The only sampled content is the explicitly supplied background canvas. This
 * does not capture the screen or read arbitrary DOM content. Keep icons/text in
 * normal DOM above this canvas so they remain sharp and accessible.
 *
 * Each surface is an independent, axis-aligned rounded rectangle. Translation
 * and scale work; rotation, arbitrary silhouettes, surface merging and refraction
 * of other glass surfaces are outside the scope of this small renderer.
 */

const VERTEX_SOURCE = `#version 300 es
precision highp float;
void main() {
  vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_background;
uniform vec2 u_resolution;
uniform vec2 u_cssSize;
uniform int u_mode;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_blur;
uniform float u_refraction;
uniform vec4 u_tint;
uniform float u_rim;
uniform float u_dispersion;
uniform int u_recovered;
uniform float u_refractionHeight;
uniform int u_composition;
uniform int u_sdfEdge;
uniform float u_surfaceOpacity;
out vec4 outColor;

${RECOVERED_OPTICS_GLSL}
${RECOVERED_COMPOSITE_GLSL}
${RECOVERED_SDF_HIGHLIGHT_GLSL}
${RECOVERED_VIBRANCY_GLSL}
uniform RecoveredCompositeParams u_composite;
uniform RecoveredSdfHighlightParams u_sdfHighlight;
uniform RecoveredVibrancyParams u_vibrancy;

float roundedRectSDF(vec2 local, vec2 halfSize, float radius) {
  vec2 q = abs(local) - halfSize + radius;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

vec2 roundedRectNormal(vec2 local, vec2 halfSize, float radius) {
  vec2 q = abs(local) - halfSize + radius;
  vec2 outside = max(q, vec2(0.0));
  vec2 quadrant = vec2(local.x < 0.0 ? -1.0 : 1.0, local.y < 0.0 ? -1.0 : 1.0);
  if (dot(outside, outside) > 0.00001) return normalize(outside) * quadrant;
  return (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * quadrant;
}

vec3 backgroundAt(vec2 cssPoint) {
  // Canvas uploads use top-to-bottom image data; cssPoint is also top-to-bottom.
  return texture(u_background, clamp(cssPoint / u_cssSize, 0.0, 1.0)).rgb;
}

vec3 softBackground(vec2 point, float blur) {
  if (blur < 0.05) return backgroundAt(point);
  // A bounded, 13-tap approximation. It is deliberately not a costly live
  // framebuffer blur; large blur radii will differ from a native Gaussian blur.
  float inner = blur * 0.42;
  float diagonal = blur * 0.30;
  float outer = blur * 0.90;
  vec3 color = backgroundAt(point) * 0.20;
  color += backgroundAt(point + vec2(inner, 0.0)) * 0.09;
  color += backgroundAt(point - vec2(inner, 0.0)) * 0.09;
  color += backgroundAt(point + vec2(0.0, inner)) * 0.09;
  color += backgroundAt(point - vec2(0.0, inner)) * 0.09;
  color += backgroundAt(point + vec2(diagonal, diagonal)) * 0.06;
  color += backgroundAt(point + vec2(diagonal, -diagonal)) * 0.06;
  color += backgroundAt(point + vec2(-diagonal, diagonal)) * 0.06;
  color += backgroundAt(point - vec2(diagonal, diagonal)) * 0.06;
  color += backgroundAt(point + vec2(outer, 0.0)) * 0.05;
  color += backgroundAt(point - vec2(outer, 0.0)) * 0.05;
  color += backgroundAt(point + vec2(0.0, outer)) * 0.05;
  color += backgroundAt(point - vec2(0.0, outer)) * 0.05;
  return color;
}

void renderMaterial() {
  vec2 screenUV = gl_FragCoord.xy / u_resolution;
  vec2 point = vec2(screenUV.x, 1.0 - screenUV.y) * u_cssSize;
  if (u_mode == 0) {
    outColor = vec4(backgroundAt(point), 1.0);
    return;
  }

  vec2 halfSize = u_rect.zw * 0.5;
  vec2 local = point - (u_rect.xy + halfSize);
  float distance = roundedRectSDF(local, halfSize, u_radius);
  vec2 normal = roundedRectNormal(local, halfSize, u_radius);
  if (u_composition == 1) {
    float shadowDistance = roundedRectSDF(local - u_composite.shadowOffset, halfSize, u_radius);
    float ringDistance = roundedRectSDF(local - u_composite.ringOffset, halfSize, u_radius);
    outColor = recoveredCompositeSample(point, normal, distance, 1.0,
      max(fwidth(distance), 0.0001), vec2(shadowDistance, 1.0),
      vec2(ringDistance, 1.0), u_composite);
    // The native-path helper already returns premultiplied RGBA. Prototype tint
    // is a separate caller choice; calibration supplies a zero-alpha tint.
    outColor.rgb = mix(outColor.rgb, u_tint.rgb * outColor.a, u_tint.a);
    if(u_sdfEdge > 0) {
      vec4 sourceSdf=vec4(distance,normal,1.0);
      vec4 mask=u_sdfEdge==2?recoveredSdfDiffuseKeyFillHighlight(sourceSdf,u_sdfHighlight)
        :recoveredSdfKeyFillHighlight(sourceSdf,u_sdfHighlight);
      // The recovered mask operation needs a backdrop. This Web adapter uses
      // its composed scene; the native intermediate route is still unobserved.
      vec4 scene=vec4(outColor.rgb+backgroundAt(point)*(1.0-outColor.a),1.0);
      vec4 edge=recoveredVibrantMask(mask,scene,u_vibrancy);
      outColor=edge+outColor*(1.0-edge.a);
    }
    return;
  }
  float aa = max(fwidth(distance) * 0.75, 0.35);
  float coverage = 1.0 - smoothstep(-aa, aa, distance);
  if (coverage <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  float depth = max(-distance, 0.0);
  float band = clamp(min(halfSize.x, halfSize.y) * 0.55, 7.0, 34.0);
  float t = clamp(depth / band, 0.0, 1.0);
  // The fitted optical displacement is strongest near the rounded edge and
  // decays nonlinearly into a nearly flat central region.
  float edge = 1.0 - smoothstep(0.0, 1.0, t);
  float lens = pow(edge, 1.65) * (0.34 + 0.66 * smoothstep(0.0, 0.30, t));
  vec2 centerLens = local * (u_refraction / 1200.0) * (1.0 - edge);
  vec2 samplePoint = point + normal * u_refraction * lens + centerLens;
  // Reduced edge blur keeps the optical rim distinct from the soft interior.
  float localBlur = u_blur * mix(1.0, 0.38, edge * edge);
  vec3 color = u_recovered == 1
    ? recoveredGlassSample(point, normal, distance, u_refraction,
        u_refractionHeight, u_blur, u_dispersion)
    : softBackground(samplePoint, localBlur);

  if (u_recovered == 0 && u_dispersion > 0.001) {
    vec2 split = normal * u_dispersion * edge * edge;
    vec3 centerSample = backgroundAt(samplePoint);
    vec3 splitSample = vec3(
      backgroundAt(samplePoint + split).r,
      centerSample.g,
      backgroundAt(samplePoint - split).b
    );
    // Add only channel differences, preserving the main soft sample.
    color += (splitSample - centerSample) * 0.55;
  }

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, 1.07);
  color = mix(color, u_tint.rgb, u_tint.a);

  float fineRim = exp(-pow(depth / 1.15, 2.0));
  float wideRim = exp(-depth / 3.7);
  float light = pow(max(dot(normal, normalize(vec2(-0.65, -0.76))), 0.0), 1.5);
  float lowerLight = pow(max(dot(normal, normalize(vec2(0.55, 0.84))), 0.0), 3.0);
  float shade = max(dot(normal, normalize(vec2(0.78, 0.63))), 0.0);
  color *= 1.0 - u_rim * shade * wideRim * 0.075;
  color += u_rim * (fineRim * (0.085 + light * 0.28 + lowerLight * 0.10)
    + wideRim * light * 0.035);
  outColor = vec4(clamp(color, 0.0, 1.0), coverage);
}
// CSS opacity is a wrapper concern, applied after the recovered material math.
// Its default is 1, preserving the measured material path without a style tint.
void main() {
  renderMaterial();
  if(u_mode != 0) outColor *= u_surfaceOpacity;
}`;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create a WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(`Glass shader compilation failed: ${message}`);
  }
  return shader;
}

/**
 * @typedef {Object} GlassSurface
 * @property {Element} element A DOM element locating the glass; its content stays DOM.
 * @property {number} [radius=24] Untransformed corner radius in CSS pixels.
 * @property {number} [blur=12] Fitted blur extent in CSS pixels, clamped to 0–32.
 * @property {number} [refraction=18] Edge displacement in CSS pixels, clamped to ±64.
 * @property {number[]} [tint=[1,1,1,0.06]] Normalized RGBA, not 0–255 values.
 * @property {number} [rim=0.8] Fitted edge-light strength, clamped to 0–2.
 * @property {number} [dispersion=0.35] RGB separation in CSS pixels; 0 disables it.
 */

class GlassRenderer {
  /**
   * @param {HTMLCanvasElement} canvas Stage-local overlay, explicitly sized by CSS.
   * @param {{background: HTMLCanvasElement|OffscreenCanvas,
   *   surfaces: () => GlassSurface[], onError?: (error: Error) => void,
   *   onRestore?: (renderer: GlassRenderer) => void}} options
   */
  constructor(canvas, { background, surfaces = () => [], onError, onRestore, backgroundKernel = 'variable13' } = {}) {
    this.canvas = canvas;
    this.background = background;
    this.surfaces = surfaces;
    this.backgroundKernel = backgroundKernel;
    this.onError = typeof onError === "function" ? onError : null;
    this.onRestore = typeof onRestore === "function" ? onRestore : null;
    // A renderer mounted in an iframe must use that document's DPR and scheduler.
    this._window = canvas?.ownerDocument?.defaultView || globalThis;
    this.gl = null;
    this._status = "initializing";
    this._error = null;
    this._running = false;
    this._destroyed = false;
    this._raf = 0;
    this._uploads = 0;
    this._surfaceCount = 0;
    this._drawCalls = 0;
    this._dpr = 1;
    this._cssWidth = 0;
    this._cssHeight = 0;
    this._version = null;
    this._resumeAfterRestore = false;
    this._tick = this._tick.bind(this);
    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);

    try {
      if (!canvas || typeof canvas.getContext !== "function") {
        throw new Error("GlassRenderer requires an HTML canvas.");
      }
      canvas.addEventListener("webglcontextlost", this._onContextLost);
      canvas.addEventListener("webglcontextrestored", this._onContextRestored);
      this.gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      });
      if (!this.gl) throw new Error("WebGL 2 is unavailable; use the CSS glass fallback.");
      this._initialize();
    } catch (error) {
      this._releaseResources();
      this._fail(error, this.gl ? "error" : "unavailable");
    }
  }

  _initialize() {
    const gl = this.gl;
    this._releaseResources();
    let vertex;
    let fragment;
    let program;
    try {
      vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
      fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
      program = gl.createProgram();
      if (!program) throw new Error("Unable to create the glass WebGL program.");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Glass shader linking failed: ${gl.getProgramInfoLog(program) || "Unknown link error."}`);
      }
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }

    this._program = program;
    this._vao = gl.createVertexArray();
    this._texture = gl.createTexture();
    if (!this._vao || !this._texture) throw new Error("Unable to allocate glass WebGL resources.");
    this._uniforms = {};
    for (const name of ["background", "resolution", "cssSize", "mode", "rect", "radius", "blur", "refraction", "tint", "rim", "dispersion", "recovered", "refractionHeight", "composition", "sdfEdge", "surfaceOpacity"]) {
      this._uniforms[name] = gl.getUniformLocation(program, `u_${name}`);
    }
    gl.useProgram(program);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this._uniforms.background, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._version = gl.getParameter(gl.VERSION);
    this._backgroundProcessor = createRecoveredBackground(gl);
    this._error = null;
    this._status = "ready";
    this.uploadBackground();
  }

  _releaseResources({ canDelete = true } = {}) {
    const gl = this.gl;
    if (canDelete && gl && !gl.isContextLost()) {
      this._pyramid?.dispose();
      this._backgroundProcessor?.dispose();
      if (this._texture) gl.deleteTexture(this._texture);
      if (this._vao) gl.deleteVertexArray(this._vao);
      if (this._program) gl.deleteProgram(this._program);
    }
    // Handles from a lost context are invalid even after it is restored.
    this._pyramid = null;
    this._backgroundProcessor = null;
    this._texture = null;
    this._vao = null;
    this._program = null;
    this._uniforms = null;
  }

  _fail(error, status = "error") {
    this.stop();
    this._error = error instanceof Error ? error : new Error(String(error));
    this._status = status;
    if (this.onError) {
      try { this.onError(this._error); } catch { /* A consumer callback must not restart a failing frame loop. */ }
    }
  }

  _onContextLost(event) {
    event.preventDefault();
    this._resumeAfterRestore = this._running;
    this._releaseResources({ canDelete: false });
    this._fail(new Error("The glass WebGL context was lost."), "context-lost");
  }

  _onContextRestored() {
    if (this._destroyed) return;
    const resume = this._resumeAfterRestore;
    this._resumeAfterRestore = false;
    try {
      this._initialize();
      if (!this._error) {
        // Static consumers also need a first frame after restoration.
        if (resume) this.start();
        else this.render();
        if (!this._error && this.onRestore) {
          try { this.onRestore(this); } catch { /* Consumer callbacks cannot break restoration. */ }
        }
      }
    } catch (error) {
      this._releaseResources();
      this._fail(error);
    }
  }

  /** Call only after drawing/changing the explicit background canvas. */
  uploadBackground() {
    const gl = this.gl;
    if (this._destroyed || !gl || !this._texture || gl.isContextLost()) return false;
    try {
      if (!this.background || !(this.background.width > 0) || !(this.background.height > 0)) {
        throw new Error("The glass background must be a non-empty canvas.");
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.background);
      this._pyramid?.dispose();
      this._pyramid = null;
      if (this.backgroundKernel === 'webgl') gl.generateMipmap(gl.TEXTURE_2D);
      else this._pyramid = this._backgroundProcessor.buildPyramid(this.background, { kernel: this.backgroundKernel });
      // Kernel arithmetic is instruction-derived. Repeated mip scheduling,
      // RGBA8 storage and source selection are explicit browser adaptations.
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) throw new Error(`Background texture upload failed (WebGL ${uploadError}).`);
      this._backgroundWidth = this.background.width;
      this._backgroundHeight = this.background.height;
      this._uploads += 1;
      return true;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  /** Render one frame. DOM bounds are read afresh, including press/drag transforms. */
  render() {
    const gl = this.gl;
    if (this._destroyed || this._error || !gl || gl.isContextLost()) return false;
    try {
      const stage = this.canvas.getBoundingClientRect();
      if (!(stage.width > 0) || !(stage.height > 0)) return false;
      const dpr = clamp(numberOr(this._window.devicePixelRatio, 1), 1, 2);
      const width = Math.max(1, Math.round(stage.width * dpr));
      const height = Math.max(1, Math.round(stage.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this._dpr = dpr;
      this._cssWidth = stage.width;
      this._cssHeight = stage.height;
      this._surfaceCount = 0;
      this._drawCalls = 1;

      gl.viewport(0, 0, width, height);
      gl.useProgram(this._program);
      gl.bindVertexArray(this._vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._pyramid?.texture || this._texture);
      gl.uniform2f(this._uniforms.resolution, width, height);
      gl.uniform2f(this._uniforms.cssSize, stage.width, stage.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.uniform1i(this._uniforms.mode, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const surfaces = this.surfaces() || [];
      const visible = [];
      // Read all bounds before issuing surface draw calls. No DOM writes occur.
      for (const surface of surfaces) {
        if (!surface?.element || typeof surface.element.getBoundingClientRect !== "function") continue;
        const element = surface.element;
        const rect = element.getBoundingClientRect();
        const x = rect.left - stage.left;
        const y = rect.top - stage.top;
        if (!(rect.width > 0) || !(rect.height > 0) || x >= stage.width || y >= stage.height || x + rect.width <= 0 || y + rect.height <= 0) continue;
        // offsetWidth/Height describe untransformed CSS dimensions. Scale the
        // requested radius with an ordinary button's scale() press animation.
        const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
        const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
        const scale = Math.min(scaleX, scaleY);
        visible.push({ surface, rect, x, y, scale });
      }

      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.uniform1i(this._uniforms.mode, 1);
      const pixelScaleX = width / stage.width;
      const pixelScaleY = height / stage.height;
      for (const { surface, rect, x, y, scale } of visible) {
        const composite = surface.composite;
        const cp = composite?.uniforms || composite;
        const margin = composite ? Math.max(2, 2 * (cp.shadowInvRadius > 0 ? 1 / cp.shadowInvRadius : 0)
          + Math.hypot(...cp.shadowOffset), cp.ringRadius * 3 + Math.hypot(...cp.ringOffset)) : 1;
        const left = clamp(Math.floor((x - margin) * pixelScaleX), 0, width);
        const right = clamp(Math.ceil((x + rect.width + margin) * pixelScaleX), 0, width);
        const top = clamp(Math.floor((y - margin) * pixelScaleY), 0, height);
        const bottom = clamp(Math.ceil((y + rect.height + margin) * pixelScaleY), 0, height);
        if (right <= left || bottom <= top) continue;
        gl.scissor(left, height - bottom, right - left, bottom - top);
        gl.uniform4f(this._uniforms.rect, x, y, rect.width, rect.height);
        gl.uniform1f(this._uniforms.radius, clamp(numberOr(surface.radius, 24) * scale, 0, Math.min(rect.width, rect.height) / 2));
        gl.uniform1f(this._uniforms.blur, clamp(numberOr(surface.blur, 12), 0, 32));
        gl.uniform1f(this._uniforms.refraction, clamp(numberOr(surface.refraction, 18), -150, 100));
        gl.uniform1f(this._uniforms.rim, clamp(numberOr(surface.rim, 0.8), 0, 2));
        gl.uniform1f(this._uniforms.dispersion, clamp(numberOr(surface.dispersion, 0.35), 0, 16));
        gl.uniform1i(this._uniforms.recovered, surface.profile === 'recovered' ? 1 : 0);
        gl.uniform1f(this._uniforms.refractionHeight, clamp(numberOr(surface.refractionHeight, 20), 0.1, 120));
        gl.uniform1i(this._uniforms.composition, composite ? 1 : 0);
        gl.uniform1f(this._uniforms.surfaceOpacity,clamp(numberOr(surface.opacity,1),0,1));
        gl.blendFunc(composite ? gl.ONE : gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        if (composite) bindCompositeUniforms(gl, this._program, composite);
        const edge=composite&&surface.sdfHighlight&&surface.vibrancy;
        gl.uniform1i(this._uniforms.sdfEdge,edge?(surface.sdfHighlight.diffuse?2:1):0);
        if(edge){bindSdfHighlightUniforms(gl,this._program,surface.sdfHighlight);bindVibrancyUniforms(gl,this._program,surface.vibrancy);}
        const tint = surface.tint || [1, 1, 1, 0.06];
        gl.uniform4f(this._uniforms.tint,
          clamp(numberOr(tint[0], 1), 0, 1), clamp(numberOr(tint[1], 1), 0, 1),
          clamp(numberOr(tint[2], 1), 0, 1), clamp(numberOr(tint[3], 0.06), 0, 1));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this._surfaceCount += 1;
        this._drawCalls += 1;
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      return true;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  _tick() {
    this._raf = 0;
    if (!this._running || this._destroyed) return;
    this.render();
    if (this._running && !this._error) this._raf = this._window.requestAnimationFrame(this._tick);
  }

  start() {
    if (this._destroyed || this._running || this._error || !this.gl) return false;
    this._running = true;
    this._status = "running";
    this._tick();
    return this._running;
  }

  stop() {
    if (this._raf) this._window.cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._running = false;
    if (this._status === "running") this._status = "stopped";
  }

  get diagnostics() {
    return {
      status: this._status,
      version: this._version,
      error: this._error?.message || null,
      dpr: this._dpr,
      cssSize: [this._cssWidth, this._cssHeight],
      pixelSize: [this.canvas?.width || 0, this.canvas?.height || 0],
      backgroundSize: [this._backgroundWidth || 0, this._backgroundHeight || 0],
      backgroundKernel: this.backgroundKernel,
      pyramidLevels: this._pyramid?.levels || 0,
      textureUploads: this._uploads,
      surfaces: this._surfaceCount,
      drawCalls: this._drawCalls,
    };
  }

  destroy() {
    if (this._destroyed) return;
    this.stop();
    this.canvas?.removeEventListener?.("webglcontextlost", this._onContextLost);
    this.canvas?.removeEventListener?.("webglcontextrestored", this._onContextRestored);
    this._releaseResources();
    this.background = null;
    this.surfaces = () => [];
    this.onError = null;
    this.onRestore = null;
    this._destroyed = true;
    this._status = "destroyed";
  }
}

return {GlassRenderer};
})();

// core/native-materials.js
const m9=(()=>{
/**
 * Read-only material input samples from explicitly identified native probes.
 * Generated from research/deep/native-preset-inputs.json. The provenance on each
 * record identifies its exact capture, state, appearance, owner and frame range.
 *
 * Six Aqua records preserve the same-burst inactive/active state partition.
 * Three ActiveDark records preserve a separate static active DarkAqua capture;
 * their full material composition has not been implemented by the demo renderer.
 * All 77 original filter input fields are retained in each raw record.
 *
 * These are observed model-layer glassBackground filter inputs for the named
 * owner, activation state, appearance and captured calibration geometry.
 * They are not universal system defaults or decoded shader uniform coefficients.
 * The probe's geometry, tint and content were analyst-chosen calibration inputs.
 * No numeric conversion to CSS pixels or SVG filter units has been established.
 * null means unresolved/not exposed through KVC; it must not become a zero.
 * In particular all four inputAberration* fields remain explicitly null.
 * Original input* names and floating-point values are preserved without aliases.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const RAW_NATIVE_MATERIAL_PRESETS = deepFreeze({
  "regularInactive": {
    "id": "regularInactive",
    "material": "regular",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 5,
      "frames": [
        0,
        1
      ],
      "state": "inactive",
      "appearance": "NSAppearanceNameAqua",
      "owner": "glass-preset-0",
      "preset": "glass-preset-0",
      "applicationIsActive": false,
      "windowIsKey": false,
      "windowIsMain": false,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 70.69999999999999,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.8999999761581421,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 70.69999999999999,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": 0,
      "inputBlurDistance1": 0,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0.6749999523162842,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0.800000011920929,
      "inputBlurOpacity1": 0.800000011920929,
      "inputBlurOpacity2": 1,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.4000000059604645,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 0.9399999976158142,
      "inputFaceColorMatrixSaturation": 1.2000000476837158,
      "inputFaceColorMatrixWhite": 0.9599999785423279,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.5,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.1875,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 2.0943951023931953,
      "inputKeyFillHighlightSpreadSDR": 2.0943951023931953,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 0,
      "inputOuterRefractionHeight": 0,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 1,
      "inputSDRGradientDistance1": 1,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0,
      "inputShadowRadius": 0,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "clearInactive": {
    "id": "clearInactive",
    "material": "clear",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 5,
      "frames": [
        0,
        1
      ],
      "state": "inactive",
      "appearance": "NSAppearanceNameAqua",
      "owner": "glass-preset-1",
      "preset": "glass-preset-1",
      "applicationIsActive": false,
      "windowIsKey": false,
      "windowIsMain": false,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 0,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.75,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 0,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": 0,
      "inputBlurDistance1": 0,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 0,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 1,
      "inputBlurOpacity1": 1,
      "inputBlurOpacity2": 1,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 10,
      "inputClamp": 1,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.20000000298023224,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0.10000000149011612
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 1,
      "inputFaceColorMatrixSaturation": 1,
      "inputFaceColorMatrixWhite": 0.949999988079071,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.3089969389957472,
      "inputKeyFillHighlightSpreadSDR": 1.3089969389957472,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 0,
      "inputOuterRefractionHeight": 0,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0,
      "inputRingShadowBlurRadius": 0,
      "inputRingShadowMask": 0,
      "inputRingShadowOffset": 0,
      "inputRingShadowOpacity": 0,
      "inputRingShadowStrokeWidth": 0,
      "inputSDRGradientDistance0": 1,
      "inputSDRGradientDistance1": 1,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 75,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.10000000149011612
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1.2000000476837158,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 80.80000000000001,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0,
      "inputShadowRadius": 0,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "buttonInactive": {
    "id": "buttonInactive",
    "material": "button",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 5,
      "frames": [
        0,
        1
      ],
      "state": "inactive",
      "appearance": "NSAppearanceNameAqua",
      "owner": "native-glass-button-0",
      "preset": "glass-preset-0",
      "applicationIsActive": false,
      "windowIsKey": false,
      "windowIsMain": false,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVS_12AppKitButton_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 11.2,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.8999999761581421,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 11.2,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": 0,
      "inputBlurDistance1": 0,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0.6749999523162842,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0.4000000059604645,
      "inputBlurOpacity1": 0.4000000059604645,
      "inputBlurOpacity2": 1,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.4000000059604645,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 0.9399999976158142,
      "inputFaceColorMatrixSaturation": 1.2000000476837158,
      "inputFaceColorMatrixWhite": 0.9599999785423279,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -16,
      "inputInnerRefractionHeight": 8,
      "inputKeyFillHighlightAmount": 0.5,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.1875,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 2.0943951023931953,
      "inputKeyFillHighlightSpreadSDR": 2.0943951023931953,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 0,
      "inputOuterRefractionHeight": 0,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 1,
      "inputSDRGradientDistance1": 1,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0,
      "inputShadowRadius": 0,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "regularActive": {
    "id": "regularActive",
    "material": "regular",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 6,
      "frames": [
        2,
        59
      ],
      "state": "active",
      "appearance": "NSAppearanceNameAqua",
      "owner": "glass-preset-0",
      "preset": "glass-preset-0",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 70.69999999999999,
      "inputBleedBlurRadius": 70.69999999999999,
      "inputBleedColorMatrixBlack": 0.8999999761581421,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 70.69999999999999,
      "inputBleedOpacity": 0.5,
      "inputBlurDistance0": -101,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0.6749999523162842,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0.800000011920929,
      "inputBlurOpacity1": 0.4000000059604645,
      "inputBlurOpacity2": 0.5,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1.0696101188659668,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.4000000059604645,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 0.9399999976158142,
      "inputFaceColorMatrixSaturation": 1.2000000476837158,
      "inputFaceColorMatrixWhite": 1.0299999713897705,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.6755160819145565,
      "inputKeyFillHighlightSpreadSDR": 1.8500490071139892,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 50.5,
      "inputOuterRefractionHeight": 40.400000000000006,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0.6000000238418579,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0.05999999865889549,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0.4000000059604645,
      "inputShadowRadius": 24,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "clearActive": {
    "id": "clearActive",
    "material": "clear",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 6,
      "frames": [
        2,
        59
      ],
      "state": "active",
      "appearance": "NSAppearanceNameAqua",
      "owner": "glass-preset-1",
      "preset": "glass-preset-1",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 0,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.75,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 0,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": -101,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 0,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0,
      "inputBlurOpacity1": 0,
      "inputBlurOpacity2": 0,
      "inputBlurOpacity3": 0,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 0,
      "inputClamp": 1.1917475461959839,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.125,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 1,
      "inputFaceColorMatrixSaturation": 1.059999942779541,
      "inputFaceColorMatrixWhite": 1.0800000429153442,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.3089969389957472,
      "inputKeyFillHighlightSpreadSDR": 1.3089969389957472,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 40.400000000000006,
      "inputOuterRefractionHeight": 25.25,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0,
      "inputRingShadowBlurRadius": 0,
      "inputRingShadowMask": 0,
      "inputRingShadowOffset": 0,
      "inputRingShadowOpacity": 0,
      "inputRingShadowStrokeWidth": 0,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 75,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.10000000149011612
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1.2000000476837158,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 80.80000000000001,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0,
      "inputShadowRadius": 0,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "buttonActive": {
    "id": "buttonActive",
    "material": "button",
    "provenance": {
      "source": "research/deep/native-probe/captures/burst-2026-10-16T07-44-31-652Z-8.json",
      "sourceSha256": "7e7b40231eafc861f2cbd0de95fd47b9310d10cd5778f8335ecc112acf8af135",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 6,
      "frames": [
        2,
        59
      ],
      "state": "active",
      "appearance": "NSAppearanceNameAqua",
      "owner": "native-glass-button-0",
      "preset": "glass-preset-0",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVS_12AppKitButton_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 11.2,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.8999999761581421,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 11.2,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": -16,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0.6749999523162842,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0,
      "inputBlurOpacity1": 0,
      "inputBlurOpacity2": 0.5,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1.0696101188659668,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.4000000059604645,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 0.9399999976158142,
      "inputFaceColorMatrixSaturation": 1.2000000476837158,
      "inputFaceColorMatrixWhite": 1.0299999713897705,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -16,
      "inputInnerRefractionHeight": 8,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.6755160819145565,
      "inputKeyFillHighlightSpreadSDR": 1.8500490071139892,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 16,
      "inputOuterRefractionHeight": 16,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0.6000000238418579,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0.05999999865889549,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0.03999999910593033,
      "inputShadowRadius": 4,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "regularActiveDark": {
    "id": "regularActiveDark",
    "material": "regular",
    "provenance": {
      "source": "research/deep/native-probe/captures/diagnostics-2026-10-16T07-54-30-838Z-11.json",
      "sourceSha256": "7c65db93c40cd687a952c78fb1753dab61ab01986847428ee197a10c750622b7",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 14,
      "frames": [
        0,
        0
      ],
      "state": "active",
      "appearance": "NSAppearanceNameDarkAqua",
      "owner": "glass-preset-0",
      "preset": "glass-preset-0",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 70.69999999999999,
      "inputBleedBlurRadius": 70.69999999999999,
      "inputBleedColorMatrixBlack": 0.125,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1,
      "inputBleedColorMatrixWhite": 0.5,
      "inputBleedDarkenBlend": 0,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 70.69999999999999,
      "inputBleedOpacity": 0.800000011920929,
      "inputBlurDistance0": -101,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0.6749999523162842,
      "inputBlurFillLightenOpacity": 0,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0.800000011920929,
      "inputBlurOpacity1": 0.4000000059604645,
      "inputBlurOpacity2": 0.5,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1.308310866355896,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.125,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0.1249999925494194,
            0.1249999925494194,
            0.1249999925494194,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 0.44999998807907104,
      "inputFaceColorMatrixMaxLumaSDR": 0.44999998807907104,
      "inputFaceColorMatrixSaturation": 1.2999999523162842,
      "inputFaceColorMatrixWhite": 1.125,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.3089969389957472,
      "inputKeyFillHighlightSpreadSDR": 1.3089969389957472,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 50.5,
      "inputOuterRefractionHeight": 40.400000000000006,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0.6000000238418579,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0.05999999865889549,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0.6000000238418579,
      "inputShadowRadius": 24,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "clearActiveDark": {
    "id": "clearActiveDark",
    "material": "clear",
    "provenance": {
      "source": "research/deep/native-probe/captures/diagnostics-2026-10-16T07-54-30-838Z-11.json",
      "sourceSha256": "7c65db93c40cd687a952c78fb1753dab61ab01986847428ee197a10c750622b7",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 14,
      "frames": [
        0,
        0
      ],
      "state": "active",
      "appearance": "NSAppearanceNameDarkAqua",
      "owner": "glass-preset-1",
      "preset": "glass-preset-1",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVES_CSo17NSGlassEffectViewP10$18dad3df48RootView_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 0,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.75,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1.2000000476837158,
      "inputBleedColorMatrixWhite": 1,
      "inputBleedDarkenBlend": 1,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 0,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": -101,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 0,
      "inputBlurFillDarkenOpacity": 0,
      "inputBlurFillLightenOpacity": 0,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0,
      "inputBlurOpacity1": 0,
      "inputBlurOpacity2": 0,
      "inputBlurOpacity3": 0,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 0,
      "inputClamp": 1.1917475461959839,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.125,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            1,
            1,
            1,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 1,
      "inputFaceColorMatrixMaxLumaSDR": 1,
      "inputFaceColorMatrixSaturation": 1.059999942779541,
      "inputFaceColorMatrixWhite": 1.0800000429153442,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -60,
      "inputInnerRefractionHeight": 20,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.3089969389957472,
      "inputKeyFillHighlightSpreadSDR": 1.3089969389957472,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 40.400000000000006,
      "inputOuterRefractionHeight": 25.25,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0,
      "inputRingShadowBlurRadius": 0,
      "inputRingShadowMask": 0,
      "inputRingShadowOffset": 0,
      "inputRingShadowOpacity": 0,
      "inputRingShadowStrokeWidth": 0,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 75,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.10000000149011612
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1.2000000476837158,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 80.80000000000001,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0,
      "inputShadowRadius": 0,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  },
  "buttonActiveDark": {
    "id": "buttonActiveDark",
    "material": "button",
    "provenance": {
      "source": "research/deep/native-probe/captures/diagnostics-2026-10-16T07-54-30-838Z-11.json",
      "sourceSha256": "7c65db93c40cd687a952c78fb1753dab61ab01986847428ee197a10c750622b7",
      "extractionSource": "research/deep/native-preset-inputs.json",
      "extractionSourceSha256": "193bb3bfb1e18d52f3c80b909f39e737405a8d5c37345cafd9cc55df03b9c3af",
      "extractionCaptureIndex": 14,
      "frames": [
        0,
        0
      ],
      "state": "active",
      "appearance": "NSAppearanceNameDarkAqua",
      "owner": "native-glass-button-0",
      "preset": "glass-preset-0",
      "applicationIsActive": true,
      "windowIsKey": true,
      "windowIsMain": true,
      "environment": {
        "increaseContrast": false,
        "reduceMotion": false,
        "reduceTransparency": false
      },
      "layerClass": "CABackdropLayer",
      "relativeLayerPath": "root/NSViewBackingLayer[_TtGC6AppKit18_NSCoreHostingViewVS_12AppKitButton_]#0/CALayer[]#0/SwiftUI.SDFLayer[]#0/CALayer[]#1/CABackdropLayer[@0]#0",
      "filterType": "glassBackground",
      "filterName": "glassBackground",
      "filterSlot": "filters",
      "inputKeyCounts": [
        77
      ],
      "inputKeysTruncated": false
    },
    "units": "raw native model-layer filter inputs; CSS-pixel mapping uncalibrated",
    "raw": {
      "inputAberrationAmount": null,
      "inputAberrationAngle": null,
      "inputAberrationHeight": null,
      "inputAberrationOffset": null,
      "inputBleedAmount": 11.2,
      "inputBleedBlurRadius": 0,
      "inputBleedColorMatrixBlack": 0.125,
      "inputBleedColorMatrixFillColor": null,
      "inputBleedColorMatrixSaturation": 1,
      "inputBleedColorMatrixWhite": 0.5,
      "inputBleedDarkenBlend": 0,
      "inputBleedDistance0": 1,
      "inputBleedDistance1": 0,
      "inputBleedHeight": 11.2,
      "inputBleedOpacity": 0,
      "inputBlurDistance0": -16,
      "inputBlurDistance1": -1,
      "inputBlurDistance2": 0,
      "inputBlurDistance3": 0,
      "inputBlurDistance4": null,
      "inputBlurFillBlurRadius": 8,
      "inputBlurFillDarkenOpacity": 0.6749999523162842,
      "inputBlurFillLightenOpacity": 0,
      "inputBlurFillNormalOpacity": 0,
      "inputBlurOpacity0": 0,
      "inputBlurOpacity1": 0,
      "inputBlurOpacity2": 0.5,
      "inputBlurOpacity3": 1,
      "inputBlurOpacity4": null,
      "inputBlurRadius": 5,
      "inputClamp": 1.308310866355896,
      "inputClampPreserveHue": 0,
      "inputFaceColorMatrixBlack": 0.125,
      "inputFaceColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0.1249999925494194,
            0.1249999925494194,
            0.1249999925494194,
            0
          ]
        }
      },
      "inputFaceColorMatrixMaxLuma": 0.6000000238418579,
      "inputFaceColorMatrixMaxLumaSDR": 0.6000000238418579,
      "inputFaceColorMatrixSaturation": 1.2999999523162842,
      "inputFaceColorMatrixWhite": 1.125,
      "inputFaceOpacity": 1,
      "inputInnerRefractionAmount": -16,
      "inputInnerRefractionHeight": 8,
      "inputKeyFillHighlightAmount": 0.4,
      "inputKeyFillHighlightAngle": 1.5707963267948966,
      "inputKeyFillHighlightColorBias": -0.25,
      "inputKeyFillHighlightEffectOffset": -0.5,
      "inputKeyFillHighlightHeight": 0.5,
      "inputKeyFillHighlightSpread": 1.3089969389957472,
      "inputKeyFillHighlightSpreadSDR": 1.3089969389957472,
      "inputMaxHeadroom": 9999,
      "inputOuterRefractionAmount": 16,
      "inputOuterRefractionHeight": 16,
      "inputRefractionDistance0": -1,
      "inputRefractionDistance1": 0,
      "inputRefractionOpacity": 0.6000000238418579,
      "inputRingShadowBlurRadius": 5,
      "inputRingShadowMask": 1,
      "inputRingShadowOffset": 8,
      "inputRingShadowOpacity": 0.05999999865889549,
      "inputRingShadowStrokeWidth": 4,
      "inputSDRGradientDistance0": 0,
      "inputSDRGradientDistance1": 0,
      "inputSDRHoldingToneEnabled": 0,
      "inputSDRHoldingToneWhite": 1,
      "inputSDRShadowOpacity": 0,
      "inputShadowAmount": 0,
      "inputShadowBlurRadius": 0,
      "inputShadowColorMatrixBlack": 0,
      "inputShadowColorMatrixFillColor": {
        "cfType": "CGColor",
        "class": "__NSCFType",
        "color": {
          "colorSpace": "kCGColorSpaceExtendedSRGB",
          "components": [
            0,
            0,
            0,
            0.30000001192092896
          ]
        }
      },
      "inputShadowColorMatrixSaturation": 1,
      "inputShadowColorMatrixWhite": 1,
      "inputShadowDistanceOffset": 0,
      "inputShadowHeight": 0,
      "inputShadowOffset": {
        "alignment": 8,
        "byteLength": 16,
        "class": "NSConcreteValue",
        "objcType": "{CGSize=dd}",
        "rawBytesBase64": "AAAAAAAAAAAAAAAAAAAgQA=="
      },
      "inputShadowOpacity": 0.03999999910593033,
      "inputShadowRadius": 4,
      "inputShadowVibrancyContribution": 0,
      "inputSourceSublayerName": "@0"
    }
  }
});

return {RAW_NATIVE_MATERIAL_PRESETS};
})();

// core/native-edge-materials.js
const m10=(()=>{
/** Exact v6 own-AppKit runtime observations. Four sampled active material/appearance pairs; no inactive/button defaults inferred. */
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const NATIVE_EDGE_MATERIALS=freeze({
  "regularActive": {
    "raw": {
      "curvature": 0.75,
      "diffuseAmountScale": 0.15000000596046448,
      "diffuseHeightScale": 8,
      "diffuseSpreadScale": 0.6499999761581421,
      "fillAmount": 0.5,
      "fillAngle": 3.141592653589793,
      "fillColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "fillHeight": 1,
      "fillHeightOffset": 0,
      "fillHeightScale": 1,
      "fillSpread": 1.5707963267948966,
      "fillSpreadOffset": 0,
      "fillSpreadScale": 1,
      "global": 0,
      "keyAmount": 0.5,
      "keyAngle": 0,
      "keyColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "keyHeight": 1,
      "keyHeightOffset": 0,
      "keyHeightScale": 1,
      "keySpread": 1.5707963267948966,
      "keySpreadOffset": 0,
      "keySpreadScale": 1
    },
    "vibrancyRows": [
      1.1201999187469482,
      -0.18940000236034393,
      -0.01899999938905239,
      0,
      0.14710000157356262,
      -0.056299999356269836,
      0.9870999455451965,
      -0.019099999219179153,
      0,
      0.14710000157356262,
      -0.056299999356269836,
      -0.18930000066757202,
      1.1574000120162964,
      0,
      0.14710000157356262,
      0,
      0,
      0,
      1,
      0
    ],
    "layerInputs": {
      "effectOffset": 0,
      "gaussianRadius": 0,
      "mergeElements": 0,
      "smoothness": 8
    },
    "source": {
      "diagnostic": "research/deep/native-probe/captures/diagnostics-2026-10-16T09-08-36-645Z-1.json",
      "extracted": "research/phase3/native-v6-sdf-highlights.json",
      "sha256": "6a3f17ba7885fc7aeed721ed2fba8c3ad874a816681d70e4275f67176181cba5",
      "scope": "Only this sampled untinted NSGlassEffectView material/appearance, active/key/main window, radius28, 320x202pt; component adaptation is separate."
    }
  },
  "clearActive": {
    "raw": {
      "curvature": 0.75,
      "diffuseAmountScale": 0.15000000596046448,
      "diffuseHeightScale": 8,
      "diffuseSpreadScale": 0.6499999761581421,
      "fillAmount": 0.5,
      "fillAngle": 3.141592653589793,
      "fillColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "fillHeight": 1,
      "fillHeightOffset": 0,
      "fillHeightScale": 1,
      "fillSpread": 1.5707963267948966,
      "fillSpreadOffset": 0,
      "fillSpreadScale": 1,
      "global": 0,
      "keyAmount": 0.5,
      "keyAngle": 0,
      "keyColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "keyHeight": 1,
      "keyHeightOffset": 0,
      "keyHeightScale": 1,
      "keySpread": 1.5707963267948966,
      "keySpreadOffset": 0,
      "keySpreadScale": 1
    },
    "vibrancyRows": [
      1.3191999197006226,
      -0.04779999703168869,
      -0.004699999932199717,
      0,
      0.19999998807907104,
      -0.0142000000923872,
      1.285599946975708,
      -0.004799999762326479,
      0,
      0.19999998807907104,
      -0.0142000000923872,
      -0.047599997371435165,
      1.3284999132156372,
      0,
      0.19999998807907104,
      0,
      0,
      0,
      1,
      0
    ],
    "layerInputs": {
      "effectOffset": 0,
      "gaussianRadius": 0,
      "mergeElements": 0,
      "smoothness": 8
    },
    "source": {
      "diagnostic": "research/deep/native-probe/captures/diagnostics-2026-10-16T09-08-36-645Z-1.json",
      "extracted": "research/phase3/native-v6-sdf-highlights.json",
      "sha256": "6a3f17ba7885fc7aeed721ed2fba8c3ad874a816681d70e4275f67176181cba5",
      "scope": "Only this sampled untinted NSGlassEffectView material/appearance, active/key/main window, radius28, 320x202pt; component adaptation is separate."
    }
  },
  "regularActiveDark": {
    "raw": {
      "curvature": 0.75,
      "diffuseAmountScale": 0.15000000596046448,
      "diffuseHeightScale": 8,
      "diffuseSpreadScale": 0.6499999761581421,
      "fillAmount": 0.5,
      "fillAngle": 3.141592653589793,
      "fillColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "fillHeight": 1,
      "fillHeightOffset": 0,
      "fillHeightScale": 1,
      "fillSpread": 1.5707963267948966,
      "fillSpreadOffset": 0,
      "fillSpreadScale": 1,
      "global": 0,
      "keyAmount": 0.5,
      "keyAngle": 0,
      "keyColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "keyHeight": 1,
      "keyHeightOffset": 0,
      "keyHeightScale": 1,
      "keySpread": 1.5707963267948966,
      "keySpreadOffset": 0,
      "keySpreadScale": 1
    },
    "vibrancyRows": [
      1.1201999187469482,
      -0.18940000236034393,
      -0.01899999938905239,
      0,
      0.14710000157356262,
      -0.056299999356269836,
      0.9870999455451965,
      -0.019099999219179153,
      0,
      0.14710000157356262,
      -0.056299999356269836,
      -0.18930000066757202,
      1.1574000120162964,
      0,
      0.14710000157356262,
      0,
      0,
      0,
      1,
      0
    ],
    "layerInputs": {
      "effectOffset": 0,
      "gaussianRadius": 0,
      "mergeElements": 0,
      "smoothness": 8
    },
    "source": {
      "diagnostic": "research/deep/native-probe/captures/diagnostics-2026-10-16T09-09-56-550Z-2.json",
      "extracted": "research/phase3/native-v6-sdf-highlights-dark.json",
      "sha256": "6a3f17ba7885fc7aeed721ed2fba8c3ad874a816681d70e4275f67176181cba5",
      "scope": "Only this sampled untinted NSGlassEffectView material/appearance, active/key/main window, radius28, 320x202pt; component adaptation is separate."
    }
  },
  "clearActiveDark": {
    "raw": {
      "curvature": 0.75,
      "diffuseAmountScale": 0.15000000596046448,
      "diffuseHeightScale": 8,
      "diffuseSpreadScale": 0.6499999761581421,
      "fillAmount": 0.5,
      "fillAngle": 3.141592653589793,
      "fillColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "fillHeight": 1,
      "fillHeightOffset": 0,
      "fillHeightScale": 1,
      "fillSpread": 1.5707963267948966,
      "fillSpreadOffset": 0,
      "fillSpreadScale": 1,
      "global": 0,
      "keyAmount": 0.5,
      "keyAngle": 0,
      "keyColor": {
        "colorSpace": "kCGColorSpaceExtendedSRGB",
        "components": [
          1,
          1,
          1,
          1
        ]
      },
      "keyHeight": 1,
      "keyHeightOffset": 0,
      "keyHeightScale": 1,
      "keySpread": 1.5707963267948966,
      "keySpreadOffset": 0,
      "keySpreadScale": 1
    },
    "vibrancyRows": [
      1.3191999197006226,
      -0.04779999703168869,
      -0.004699999932199717,
      0,
      0.19999998807907104,
      -0.0142000000923872,
      1.285599946975708,
      -0.004799999762326479,
      0,
      0.19999998807907104,
      -0.0142000000923872,
      -0.047599997371435165,
      1.3284999132156372,
      0,
      0.19999998807907104,
      0,
      0,
      0,
      1,
      0
    ],
    "layerInputs": {
      "effectOffset": 0,
      "gaussianRadius": 0,
      "mergeElements": 0,
      "smoothness": 8
    },
    "source": {
      "diagnostic": "research/deep/native-probe/captures/diagnostics-2026-10-16T09-09-56-550Z-2.json",
      "extracted": "research/phase3/native-v6-sdf-highlights-dark.json",
      "sha256": "6a3f17ba7885fc7aeed721ed2fba8c3ad874a816681d70e4275f67176181cba5",
      "scope": "Only this sampled untinted NSGlassEffectView material/appearance, active/key/main window, radius28, 320x202pt; component adaptation is separate."
    }
  }
});

return {NATIVE_EDGE_MATERIALS};
})();

// materials.js
const m8=(()=>{
const {RAW_NATIVE_MATERIAL_PRESETS}=m9;
const {NATIVE_EDGE_MATERIALS}=m10;
const {makeCompositeParams}=m4;
const {makeSdfHighlightFromRaw}=m6;
const {makeVibrancyParams}=m7;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const RAW_KEYS = Object.freeze({ refraction: 'inputInnerRefractionAmount', refractionHeight: 'inputInnerRefractionHeight', blur: 'inputBlurRadius' });
const OPTION_NAMES = new Set(['refraction', 'refractionHeight', 'blur', 'dispersion', 'tint', 'rawToCss', 'blurPackingScale', 'headroomMix', 'extraSdf']);
const CLEAR_EDGE = new Set(['clearActive', 'clearActiveDark']);
const REGULAR_EDGE = new Set(['regularActive', 'regularActiveDark']);

/** The nine independently observed material/state combinations. */
const MATERIAL_NAMES = Object.freeze(Object.keys(RAW_NATIVE_MATERIAL_PRESETS));

function assertFiniteTree(value, path) {
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new RangeError(`${path} produces a non-finite float32 shader value`);
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertFiniteTree(child, `${path}.${key}`);
  }
}

/**
 * Return an immutable, ready-to-spread GlassRenderer surface configuration.
 * refraction/refractionHeight/blur override the sampled raw input; rawToCss scales geometry,
 * while blurPackingScale independently scales source-texture blur footprints.
 * The defaults preserve the verified demo arithmetic without a cosmetic tint.
 * extraSdf='experimental' additionally permits the observed active Regular
 * layer. No edge layer is inferred for inactive or button material records.
 */
function createMaterial(name = 'clearActive', options = {}) {
  if (typeof name !== 'string' || !own(RAW_NATIVE_MATERIAL_PRESETS, name)) {
    throw new RangeError(`Unknown material ${String(name)}; choose ${MATERIAL_NAMES.join(', ')}`);
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError('Material options must be a plain object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (!OPTION_NAMES.has(key)) throw new TypeError(`Unknown material option ${String(key)}`);
  }
  const native = RAW_NATIVE_MATERIAL_PRESETS[name];
  const defaults = {
    refraction: native.raw.inputInnerRefractionAmount,
    refractionHeight: native.raw.inputInnerRefractionHeight,
    blur: native.raw.inputBlurRadius,
    dispersion: 0, tint: [0, 0, 0, 0], rawToCss: 1,
    blurPackingScale: 1.600000023841858, headroomMix: 0, extraSdf: 'auto',
  };
  const config = { ...defaults };
  const overrides = {};
  for (const key of Object.keys(options)) {
    // An undefined optional field has the same meaning as an omitted field.
    if (options[key] === undefined) continue;
    const value = options[key];
    if (key === 'tint') {
      if (!Array.isArray(value) || value.length !== 4 || !value.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) {
        throw new TypeError('tint must contain four finite values in [0, 1]');
      }
      config.tint = [...value];
    } else if (key === 'extraSdf') {
      if (!['auto', false, 'experimental'].includes(value)) throw new TypeError("extraSdf must be 'auto', false, or 'experimental'");
      config.extraSdf = value;
    } else {
      if (!Number.isFinite(value)) throw new TypeError(`${key} must be a finite number`);
      if (['refractionHeight', 'rawToCss', 'blurPackingScale'].includes(key) && value <= 0) throw new RangeError(`${key} must be positive`);
      if (['blur', 'dispersion'].includes(key) && value < 0) throw new RangeError(`${key} must be nonnegative`);
      if (key === 'headroomMix' && (value < 0 || value > 1)) throw new RangeError('headroomMix must be in [0, 1]');
      config[key] = value;
    }
    overrides[key] = {
      original: Array.isArray(defaults[key]) ? [...defaults[key]] : defaults[key],
      value: Array.isArray(config[key]) ? [...config[key]] : config[key],
      changed: JSON.stringify(defaults[key]) !== JSON.stringify(config[key]),
      source: 'caller override',
      target: RAW_KEYS[key] || (key === 'extraSdf' ? 'independent SDF pass selection' : 'browser adapter'),
    };
  }

  if (config.extraSdf === 'experimental' && !CLEAR_EDGE.has(name) && !REGULAR_EDGE.has(name)) {
    throw new RangeError(`No independent SDF layer was captured for ${name}; it cannot be enabled by extrapolation`);
  }
  // Never write through a raw record: its nested CGColor and provenance objects
  // belong to the deeply frozen, hashed native observation.
  const effectiveRaw = { ...native.raw };
  for (const [key, rawKey] of Object.entries(RAW_KEYS)) effectiveRaw[rawKey] = config[key];
  const packing = {
    rawToCss: config.rawToCss,
    aberrationAmount: config.dispersion,
    aberrationInvHeight: 1 / (config.refractionHeight * config.rawToCss),
  };
  // Preserve the core's unresolved runtime-scale/headroom labels on defaults.
  // Passing an explicit value only changes its provenance to caller-supplied.
  if (options.blurPackingScale !== undefined) packing.blurPackingScale = config.blurPackingScale;
  if (options.headroomMix !== undefined) packing.headroomMix = config.headroomMix;
  const composite = makeCompositeParams(effectiveRaw, packing);
  const edgeEnabled = config.extraSdf !== false && (CLEAR_EDGE.has(name)
    || (config.extraSdf === 'experimental' && REGULAR_EDGE.has(name)));
  const edgeRecord = edgeEnabled ? NATIVE_EDGE_MATERIALS[name] : null;
  const sdfHighlight = edgeRecord ? makeSdfHighlightFromRaw(edgeRecord.raw, {
    diffuse: true,
    effectOffset: edgeRecord.layerInputs.effectOffset,
    normalScaleFlag: 0,
    rawToSdf: config.rawToCss,
    nodeOpacity: 1,
  }) : undefined;
  const vibrancy = edgeRecord ? makeVibrancyParams(edgeRecord.vibrancyRows) : undefined;
  const limitations = [...composite.unresolved,
    'The background must be an opaque SDR image, Canvas, video, or caller-painted texture. Arbitrary DOM content is not captured automatically.',
    'Native continuous-corner geometry, render-server backdrop routing, and runtime mip scheduling are not fully reconstructed.',
    'Native appearance is sampled in fixed probe cases; the material is not a universal macOS default or a guarantee of pixel identity on other content or geometry.',
  ];
  if (edgeRecord) limitations.push(
    'Independent SDF shader arithmetic and observed inputs are preserved; its draw normal flag, node color multiplier, and intermediate backdrop route remain explicit browser adapters.',
  );
  if (edgeEnabled && REGULAR_EDGE.has(name)) limitations.push('The Regular independent SDF layer is experimental: native model inputs were captured, but browser backdrop routing has not been calibrated for this material.');
  if (!edgeEnabled && !CLEAR_EDGE.has(name)) limitations.push('No additional SDF pass is enabled by default for this material; missing or uncalibrated branches are not inferred from Clear.');
  if (Object.values(overrides).some(record => record.changed)) limitations.push('Caller overrides alter the calibration configuration; the result no longer represents the unchanged sampled presentation.');
  const material = {
    materialName: name, profile: 'recovered',
    refraction: config.refraction * config.rawToCss,
    refractionHeight: config.refractionHeight * config.rawToCss,
    blur: config.blur, dispersion: config.dispersion, tint: [...config.tint],
    composite, ...(edgeRecord ? { sdfHighlight, vibrancy } : {}),
    provenance: {
      native: native.provenance,
      nativeUnits: native.units,
      overrides,
      nativeInputsModified: Object.keys(RAW_KEYS).some(key => config[key] !== defaults[key]),
      rawInputPolicy: 'Original deep-frozen raw records remain unchanged; overrides are applied to a separate scalar copy.',
      dispersion: 'Raw native aberration inputs remain unresolved/null. Default 0 explicitly disables the browser aberration branch.',
      tint: 'Default transparent tint adds no cosmetic recoloring.',
      coordinates: {
        rawToCss: config.rawToCss,
        source: options.rawToCss === undefined ? 'Calibrated identity geometry adapter for the sampled probe, not a universal system mapping' : 'caller override',
        blurUnits: 'Source texture pixels; no implicit multiplication by devicePixelRatio',
      },
      composition: composite.provenance,
      extraSdf: {
        enabled: edgeEnabled, selection: config.extraSdf,
        status: edgeRecord ? (REGULAR_EDGE.has(name) ? 'experimental Regular adaptation' : 'sampled active Clear adaptation') : 'disabled; no extrapolation',
        source: edgeRecord?.source ?? null,
        packing: sdfHighlight?.provenance ?? null,
        backdropAdapter: edgeRecord ? 'Web composed scene; native intermediate backdrop routing remains unobserved' : null,
      },
    },
    limitations: [...new Set(limitations)],
  };
  assertFiniteTree({ composite: composite.uniforms, sdfHighlight: sdfHighlight?.uniforms, vibrancy,
    refraction: material.refraction, refractionHeight: material.refractionHeight }, 'material');
  return freeze(material);
}

return {MATERIAL_NAMES,createMaterial};
})();

// core/recovered-spring.js
const m12=(()=>{
/**
 * Parameters recovered from SwiftUICore's GlassContainer static defaults, then
 * checked using public SwiftUI.Spring getters on macOS 27.0.1.
 * These are library presets, not a claim that every Control Center button uses
 * the same preset, target scale, delay, or state machine.
 * Evidence: research/deep/offline-glass-spring-findings.json and
 * research/deep/public-spring-probe.json.
 */
const GLASS_SPRINGS = Object.freeze({
  transition: {label:'GlassContainer · transition', duration:.5, bounce:.3},
  scaleUp: {label:'GlassContainer · scale up', duration:.35, bounce:.6},
  scaleDownHeight: {label:'GlassContainer · height return', duration:.5, bounce:.5},
  scaleDownWidth: {label:'GlassContainer · width return', duration:.5, bounce:.6},
  bridge: {label:'GlassContainer · bridge', duration:.5, bounce:0},
  kick: {label:'GlassContainer · translation kick', duration:.3, bounce:0},
  kickReturn: {label:'GlassContainer · kick return', duration:.6, bounce:.2},
});

function springParameters(duration, bounce, mass=1) {
  if (!(duration>0) || !(mass>0) || !Number.isFinite(bounce)) throw new RangeError('Invalid spring parameters');
  const ratio=bounce>=0 ? 1-Math.min(bounce,1) : 1/(bounce+1);
  if (!(ratio>=0) || !Number.isFinite(ratio)) throw new RangeError('Invalid damping ratio');
  const stiffness=mass*(2*Math.PI/duration)**2;
  const damping=2*Math.sqrt(stiffness*mass)*ratio;
  return {mass,stiffness,damping,dampingRatio:ratio};
}

// Analytic damped-oscillator propagation. Retargeting keeps the current velocity.
// This reproduces the underlying oscillator for the recovered k/c/m; SwiftUI's
// scheduling, transaction blending and private interaction triggers are separate.
function advanceSpring({x,v,target},dt,{mass=1,stiffness,damping}) {
  if (!(dt>=0) || ![x,v,target,dt,mass,stiffness,damping].every(Number.isFinite) || !(mass>0) || !(stiffness>0) || damping<0) throw new RangeError('Invalid spring state');
  const y=x-target, alpha=damping/(2*mass), omega2=stiffness/mass;
  const discriminant=omega2-alpha*alpha;
  let nextY,nextV;
  if (Math.abs(discriminant)<1e-9*omega2) {
    const e=Math.exp(-alpha*dt), b=v+alpha*y;
    nextY=e*(y+b*dt); nextV=e*(v-alpha*b*dt);
  } else if (discriminant>0) {
    const beta=Math.sqrt(discriminant), e=Math.exp(-alpha*dt), c=Math.cos(beta*dt), s=Math.sin(beta*dt);
    nextY=e*(y*c+(v+alpha*y)/beta*s);
    nextV=e*(v*c-(alpha*v+omega2*y)/beta*s);
  } else {
    const beta=Math.sqrt(-discriminant), r1=-alpha+beta, r2=-alpha-beta;
    const a=(v-r2*y)/(r1-r2), b=y-a, e1=Math.exp(r1*dt), e2=Math.exp(r2*dt);
    nextY=a*e1+b*e2; nextV=a*r1*e1+b*r2*e2;
  }
  return {x:target+nextY,v:nextV,target};
}

return {GLASS_SPRINGS,springParameters,advanceSpring};
})();

// interaction.js
const m11=(()=>{
const {GLASS_SPRINGS, springParameters, advanceSpring}=m12;
// Press is the measured mouse expansion of the native probe, rounded to 5 dp.
// Hover is a small visual fit. These amplitudes and the web event state machine
// are adapters; the spring presets/oscillator are the recovered implementation.
const PRESS_SCALE = 1.00776;
const HOVER_SCALE = 1.004;
const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar']);

function scalarScale(value) {
  const text = String(value || 'none').trim();
  if (text === 'none') return 1;
  // A computed scalar is safe to compose. Leave nonuniform/3D scales alone;
  // serializing an arbitrary CSS expression into a scalar could alter layout.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text)) return null;
  const scale = Number.parseFloat(text) / (text.endsWith('%') ? 100 : 1);
  return Number.isFinite(scale) ? scale : null;
}

/**
 * Add the measured press / fitted hover motion without replacing transform.
 * Imports are SSR safe; attachment needs an element with its own browser realm.
 * Only a computed uniform scalar CSS scale is composed. Nonuniform and 3D scales
 * are preserved, with interaction state callbacks but no additional motion.
 * `none` and reduced motion disable scaling. Destroy restores the original inline
 * scale value and priority. Do not concurrently animate scale on this element.
 */
function attachGlassInteraction(element, { enabled = true, animation = 'transition', onChange } = {}) {
  const win = element?.ownerDocument?.defaultView;
  if (!win || !element.style || typeof element.addEventListener !== 'function') {
    throw new TypeError('attachGlassInteraction requires a browser element.');
  }
  if (animation !== 'none' && !Object.prototype.hasOwnProperty.call(GLASS_SPRINGS, animation)) {
    throw new RangeError(`Unknown glass animation: ${animation}`);
  }
  if (onChange != null && typeof onChange !== 'function') throw new TypeError('onChange must be a function.');

  const doc = element.ownerDocument;
  const style = element.style;
  const originalScale = style.getPropertyValue('scale');
  const originalPriority = style.getPropertyPriority('scale');
  const preset = animation === 'none' ? null : GLASS_SPRINGS[animation];
  const parameters = preset && springParameters(preset.duration, preset.bounce);
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const listeners = [];
  const activeKeys = new Set();
  let isEnabled = Boolean(enabled), listening = Boolean(enabled), destroyed = false, reducedMotion = Boolean(media?.matches);
  let hovered = false, keyboard = false, pointerId = null, ownedScale = false, baseScale = 1;
  let frame = null, lastTime = null, state = { x: 1, v: 0, target: 1 };

  const listen = (target, type, handler, capture = false) => {
    const binding = {
      add: () => target.addEventListener(type, handler, capture),
      remove: () => target.removeEventListener(type, handler, capture),
    };
    listeners.push(binding);
    if (listening) binding.add();
  };
  const setListening = next => {
    if (listening === next) return;
    listening = next;
    for (const binding of listeners) binding[next ? 'add' : 'remove']();
  };
  const notify = () => onChange?.({
    hovered, pressed: pointerId !== null || activeKeys.size > 0, keyboard,
    scale: state.x, targetScale: state.target, reducedMotion, enabled: isEnabled,
  });
  const cancelFrame = () => {
    if (frame !== null) win.cancelAnimationFrame?.(frame);
    frame = null; lastTime = null;
  };
  const restoreScale = () => {
    if (!ownedScale) return;
    if (originalScale) style.setProperty('scale', originalScale, originalPriority);
    else style.removeProperty('scale');
    ownedScale = false;
  };
  const readBase = () => scalarScale(win.getComputedStyle?.(element)?.scale || originalScale || 'none');
  const writeScale = () => {
    if (Math.abs(state.x - 1) < 1e-12) restoreScale();
    else {
      if (!ownedScale) baseScale = readBase();
      if (baseScale === null) { state = { x: 1, v: 0, target: 1 }; restoreScale(); }
      else { style.setProperty('scale', String(baseScale * state.x), originalPriority); ownedScale = true; }
    }
    notify();
  };
  const tick = time => {
    frame = null;
    if (destroyed || !isEnabled) return;
    const dt = lastTime === null ? 0 : Math.max(0, (time - lastTime) / 1000);
    lastTime = time;
    state = advanceSpring(state, dt, parameters);
    if (Math.abs(state.x - state.target) < 1e-6 && Math.abs(state.v) < 1e-5) {
      state = { x: state.target, v: 0, target: state.target };
    }
    // Schedule before the callback: a consumer's callback can destroy this
    // binding, in which case destroy() also cancels this pending frame.
    if (state.x !== state.target || state.v !== 0) frame = win.requestAnimationFrame(tick);
    else lastTime = null;
    writeScale();
  };
  const retarget = () => {
    if (destroyed) return;
    const motion = isEnabled && !reducedMotion && parameters !== null;
    const next = !motion || keyboard ? 1 : pointerId !== null ? PRESS_SCALE : hovered ? HOVER_SCALE : 1;
    if (!ownedScale && next !== 1 && readBase() === null) {
      cancelFrame(); state = { x: 1, v: 0, target: 1 }; notify(); return;
    }
    if (!motion || typeof win.requestAnimationFrame !== 'function') {
      cancelFrame(); state = { x: next, v: 0, target: next }; writeScale(); return;
    }
    state.target = next;
    if (state.x === next && state.v === 0) { notify(); return; }
    if (frame === null) { lastTime = null; frame = win.requestAnimationFrame(tick); }
    notify();
  };
  const reset = (immediate = false) => {
    hovered = false; keyboard = false; pointerId = null; activeKeys.clear();
    if (immediate) { cancelFrame(); state = { x: 1, v: 0, target: 1 }; writeScale(); }
    else retarget();
  };
  const pointerHover = event => {
    if (!isEnabled || event.pointerType === 'touch') return;
    hovered = true; keyboard = false; retarget();
  };
  listen(element, 'pointerenter', pointerHover);
  listen(element, 'pointermove', event => { if (keyboard) pointerHover(event); });
  listen(element, 'pointerleave', () => { if (isEnabled) { hovered = false; retarget(); } });
  listen(element, 'pointerdown', event => {
    if (!isEnabled || event.button !== 0 || event.isPrimary === false || pointerId !== null) return;
    pointerId = event.pointerId; keyboard = false; activeKeys.clear();
    if (event.pointerType === 'touch') hovered = false;
    retarget();
  });
  const pointerUp = event => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    pointerId = null; retarget();
  };
  const pointerCancel = event => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    reset();
  };
  // Window capture sees release even outside the component and even if an inner
  // control stops propagation. We do not take pointer capture from a slider.
  listen(win, 'pointerup', pointerUp, true);
  listen(win, 'pointercancel', pointerCancel, true);
  listen(element, 'lostpointercapture', pointerCancel);
  listen(element, 'keydown', event => {
    if (!isEnabled || event.isComposing || !ACTIVATION_KEYS.has(event.key)) return;
    keyboard = true; pointerId = null; activeKeys.add(event.key); retarget();
  });
  listen(win, 'keyup', event => {
    if (!activeKeys.delete(event.key)) return;
    retarget();
  }, true);
  listen(element, 'blur', () => reset(), true);
  listen(win, 'blur', () => reset(true));
  listen(doc, 'visibilitychange', () => { if (doc.hidden) reset(true); });
  const mediaChange = event => { reducedMotion = Boolean(event.matches); retarget(); };
  if (media?.addEventListener) {
    listen(media, 'change', mediaChange);
  } else if (media?.addListener) {
    const binding = {add: () => media.addListener(mediaChange), remove: () => media.removeListener(mediaChange)};
    listeners.push(binding);
    if (listening) binding.add();
  }

  notify();
  return {
    setEnabled(value) {
      if (destroyed) return;
      const next = Boolean(value);
      if (next === isEnabled) return;
      isEnabled = next;
      setListening(next);
      if (next) reducedMotion = Boolean(media?.matches);
      reset(true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; cancelFrame();
      setListening(false);
      hovered = false; keyboard = false; pointerId = null; activeKeys.clear();
      state = { x: 1, v: 0, target: 1 }; restoreScale(); notify();
    },
  };
}

return {attachGlassInteraction};
})();

// background.js
const m13=(()=>{
function sourceDimensions(source) {
  const width=source&&'videoWidth' in source?source.videoWidth:source&&'naturalWidth' in source?source.naturalWidth:source?.width;
  const height=source&&'videoHeight' in source?source.videoHeight:source&&'naturalHeight' in source?source.naturalHeight:source?.height;
  if(!(width>0&&height>0))throw new TypeError('Background source has no readable pixels yet.');
  return {width,height};
}

function fitRectangle(sw,sh,width,height,fit='cover') {
  if(![sw,sh,width,height].every(n=>Number.isFinite(n)&&n>0))throw new RangeError('Image and scene dimensions must be positive.');
  if(!['cover','contain','fill'].includes(fit))throw new RangeError('fit must be cover, contain or fill.');
  if(fit==='fill')return {x:0,y:0,width,height};
  const scale=(fit==='cover'?Math.max:Math.min)(width/sw,height/sh),w=sw*scale,h=sh*scale;
  return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};
}

function paintDefaultBackground(ctx,{width:w,height:h}) {
  const gradient=ctx.createLinearGradient(0,0,w,h);
  gradient.addColorStop(0,'#008cbd');gradient.addColorStop(.48,'#35b9cd');gradient.addColorStop(1,'#173a65');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  const colors=['#baf4c48c','#234d6970','#f1f4d48c'];
  for(let i=0;i<3;i++){ctx.fillStyle=colors[i];ctx.beginPath();ctx.ellipse(w*(.15+i*.34),h*(.78-i*.22),w*.24,h*.4,-.5,0,Math.PI*2);ctx.fill();}
}

return {sourceDimensions,fitRectangle,paintDefaultBackground};
})();

// elements.js
const m1=(()=>{
const {GlassRenderer}=m2;
const {createMaterial}=m8;
const {attachGlassInteraction}=m11;
const {sourceDimensions, fitRectangle, paintDefaultBackground}=m13;
const SCENE_STYLE=`
:host{display:block;position:relative;isolation:isolate;overflow:hidden;box-sizing:border-box}
:host([hidden]){display:none!important}
#visual{position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden;border-radius:inherit;background:#426b83}
canvas,img{position:absolute;inset:0;width:100%;height:100%;display:block}
img{object-fit:cover}canvas[hidden],img[hidden]{display:none}
`;
const PANEL_STYLE=`
:host{display:block;position:relative;box-sizing:border-box;border-radius:var(--liquid-glass-radius,28px);padding:var(--liquid-glass-padding,20px)}
:host([hidden]){display:none!important}
:host([data-lg-fallback]){background:var(--liquid-glass-fallback,rgba(210,235,243,.24));backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);box-shadow:inset 0 0 0 1px rgba(255,255,255,.32),0 8px 24px rgba(0,20,35,.12)}
:host([data-lg-opaque]){background:Canvas;color:CanvasText;backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:inset 0 0 0 1px CanvasText}
`;
const makeEvent=(win,name,detail)=>new win.CustomEvent(name,{detail,bubbles:true,composed:true});

/** Classes are created only for a browser realm. Importing the package in SSR is safe. */
function createGlassElements(win) {
  class LiquidGlassScene extends win.HTMLElement {
    static get observedAttributes(){return ['background','fit','material','kernel','render-mode','continuous'];}
    constructor(){
      super();
      this.attachShadow({mode:'open'}).innerHTML=`<style>${SCENE_STYLE}</style><div id="visual" aria-hidden="true"><img id="fallback-image" hidden alt=""><canvas id="source"></canvas><canvas id="effect" hidden></canvas></div><slot></slot>`;
      this._source=this.shadowRoot.querySelector('#source');this._effect=this.shadowRoot.querySelector('#effect');this._image=this.shadowRoot.querySelector('img');
      this._ctx=this._source.getContext('2d',{colorSpace:'srgb'});this._panels=new Set();this._options={};
      this._requested=undefined;this._drawable=null;this._painter=null;this._loadId=0;this._raf=0;this._renderer=null;this._dirty=true;this._visible=true;this._attached=false;
      this._mode='loading';this._sourceError=null;this._gpuError=null;this._ready=false;this._sourceState='default';this._paintSize='';
      this._request=()=>this.refresh();this._visibility=()=>{if(this.ownerDocument.hidden){this._cancelFrame();}else this.refresh();};
      this._restore=()=>{if(!this._renderer?.diagnostics.error){this._gpuError=null;this._dirty=true;this._ready=false;this.refresh();}};
    }
    connectedCallback(){
      if(this._attached)return;this._attached=true;
      if(win.ResizeObserver){this._resize=new win.ResizeObserver(this._request);this._resize.observe(this);for(const p of this._panels)this._resize.observe(p);}
      this._mutations=new win.MutationObserver(this._request);this._mutations.observe(this,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']});
      if(win.IntersectionObserver){this._intersection=new win.IntersectionObserver(entries=>{this._visible=entries[0]?.isIntersecting!==false;if(this._visible)this.refresh();else this._cancelFrame();});this._intersection.observe(this);}
      win.addEventListener('resize',this._request);win.addEventListener('scroll',this._request,{capture:true,passive:true});
      this.ownerDocument.addEventListener('visibilitychange',this._visibility);
      this._accessibility=()=>{this._opaque=this._contrast.matches||this._transparency.matches;this._setMode(this._opaque?'css':this._mode);this.refresh();};
      this._contrast=win.matchMedia('(forced-colors: active)');this._transparency=win.matchMedia('(prefers-reduced-transparency: reduce)');
      this._contrast.addEventListener?.('change',this._accessibility);this._transparency.addEventListener?.('change',this._accessibility);this._accessibility();
      // Replay properties set before the browser upgraded an existing element.
      for(const key of ['background','materialOptions'])if(Object.prototype.hasOwnProperty.call(this,key)){const value=this[key];delete this[key];if(key==='background')this._requested=value;else this[key]=value;}
      // Listener is added after GlassRenderer's own restoration handler when it is created.
      this.setBackground(this._requested===undefined?this.getAttribute('background'):this._requested).catch(()=>{});
      this.refresh();
    }
    disconnectedCallback(){
      this._attached=false;this._loadId++;this._cancelFrame();this._resize?.disconnect();this._intersection?.disconnect();this._mutations?.disconnect();
      win.removeEventListener('resize',this._request);win.removeEventListener('scroll',this._request,true);this.ownerDocument.removeEventListener('visibilitychange',this._visibility);
      this._contrast?.removeEventListener?.('change',this._accessibility);this._transparency?.removeEventListener?.('change',this._accessibility);
      for(const p of this._panels){p._interaction?.destroy();p._interaction=null;}
      this._disposeRenderer();this._ready=false;this._paintSize='';this._setMode('css');
    }
    attributeChangedCallback(name,oldValue,value){
      if(oldValue===value)return;
      if(name==='background'){this._requested=value;if(this._attached)this.setBackground(value).catch(()=>{});}
      else if(name==='material'){for(const p of this._panels)p._material=null;this.refresh();}
      else if(name==='kernel'){this._disposeRenderer();this.refresh();}
      else if(name==='fit'){this.updateBackground();}
      else {this.refresh();}
    }
    get background(){return this._requested;}
    set background(value){this.setBackground(value).catch(()=>{});}
    get materialOptions(){return {...this._options};}
    set materialOptions(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('materialOptions must be a plain object.');this._options={...value};for(const p of this._panels)p._material=null;this.refresh();}
    async setBackground(source){
      this._requested=source;const id=++this._loadId;this._sourceError=null;this._ready=false;this._drawable=null;this._painter=null;this._image.hidden=true;this._image.removeAttribute('src');this._source.hidden=false;
      if(this._renderer?.diagnostics.error&&this._renderer.diagnostics.status!=='context-lost')this._disposeRenderer();
      if(!this._attached){this._dirty=true;return false;}
      try {
        if(source==null||source===''){this._sourceState='default';}
        else if(typeof source==='function'){this._painter=source;this._sourceState='paint';}
        else if(typeof source==='string'){
          this._sourceState='loading';const url=new URL(source,this.ownerDocument.baseURI).href;
          this._image.src=url;this._image.style.objectFit=this.getAttribute('fit')||'cover';
          const image=new win.Image();image.crossOrigin='anonymous';
          await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Background image could not be read. Use a same-origin image or enable CORS.'));image.src=url;});
          if(id!==this._loadId||!this._attached)return false;this._drawable=image;this._sourceState='image';
        } else {sourceDimensions(source);this._drawable=source;this._sourceState='pixels';}
        if(id!==this._loadId||!this._attached)return false;
        this.updateBackground();this.dispatchEvent(makeEvent(win,'glass-backgroundchange',{source:this._sourceState}));return true;
      } catch(error){
        if(id!==this._loadId)return false;this._sourceState='error';this._sourceError=error;
        this._image.hidden=typeof source!=='string';this._source.hidden=typeof source==='string';this._setMode('css');this._report(error,'background');throw error;
      }
    }
    updateBackground(){this._dirty=true;this.refresh();}
    refresh(){if(this._attached&&this._visible&&!this.ownerDocument.hidden&&!this._raf)this._raf=win.requestAnimationFrame(()=>this._frame());}
    _cancelFrame(){if(this._raf)win.cancelAnimationFrame(this._raf);this._raf=0;}
    _register(panel){this._panels.add(panel);this._resize?.observe(panel);panel._fallback(this._mode!=='webgl',this._opaque);this.refresh();}
    _unregister(panel){this._panels.delete(panel);this._resize?.unobserve(panel);this.refresh();}
    _setMode(mode){
      const changed=this._mode!==mode;this._mode=mode;this._effect.hidden=mode!=='webgl';this.setAttribute('data-lg-renderer',mode);
      for(const p of this._panels)p._fallback(mode!=='webgl',this._opaque);
      if(changed)this.dispatchEvent(makeEvent(win,'glass-modechange',{mode}));
    }
    _report(error,phase){this.dispatchEvent(makeEvent(win,'glass-error',{error,message:error.message,phase,mode:'css'}));}
    _disposeRenderer(){this._effect.removeEventListener('webglcontextrestored',this._restore);this._renderer?.destroy();this._renderer=null;this._gpuError=null;}
    _paint(){
      const bounds=this._source.getBoundingClientRect(),width=bounds.width,height=bounds.height,dpr=Math.min(win.devicePixelRatio||1,2);
      if(!(width>0&&height>0))return false;
      const key=[width,height,dpr].join(':');if(!this._dirty&&key===this._paintSize)return true;
      if(!this._ctx)throw new Error('Canvas 2D is unavailable.');
      this._source.width=Math.max(1,Math.round(width*dpr));this._source.height=Math.max(1,Math.round(height*dpr));
      const ctx=this._ctx;ctx.setTransform(this._source.width/width,0,0,this._source.height/height,0,0);ctx.fillStyle='#426b83';ctx.fillRect(0,0,width,height);
      const size={width,height,dpr,canvas:this._source};ctx.save();
      try{if(this._painter)this._painter(ctx,size);else if(this._drawable){const s=sourceDimensions(this._drawable),r=fitRectangle(s.width,s.height,width,height,this.getAttribute('fit')||'cover');ctx.drawImage(this._drawable,r.x,r.y,r.width,r.height);}else paintDefaultBackground(ctx,size);}finally{ctx.restore();}
      this._paintSize=key;this._dirty=false;
      if(this._renderer&&!this._renderer.uploadBackground())return false;
      return true;
    }
    _surfaces(){return [...this._panels].filter(p=>p.isConnected&&p._scene===this&&!p.hidden).map(p=>{
      const style=win.getComputedStyle(p);if(style.visibility==='hidden'||style.visibility==='collapse')return null;
      let opacity=1,node=p;while(node&&node!==this){if(node.nodeType===1)opacity*=Number(win.getComputedStyle(node).opacity);node=node.parentNode||node.host;}
      if(opacity<=0)return null;const surface=p._surface();return surface?{...surface,opacity}:null;
    }).filter(Boolean);}
    _frame(){
      this._raf=0;if(!this._attached||!this._visible||this.ownerDocument.hidden)return;
      try {
        if(this._sourceError)return;
        if(!this._paint())return;
        if(this.getAttribute('render-mode')==='css'||this._opaque){this._setMode('css');return;}
        if(!this._renderer){
          const kernel=this.getAttribute('kernel')||'variable13';if(!['variable13','tile2','webgl'].includes(kernel))throw new RangeError('kernel must be variable13, tile2 or webgl.');
          this._renderer=new GlassRenderer(this._effect,{background:this._source,backgroundKernel:kernel,surfaces:()=>this._surfaces(),onError:error=>{this._gpuError=error;this._setMode('css');this._ready=false;this._report(error,'webgl');}});
          this._effect.addEventListener('webglcontextrestored',this._restore);
        }
        if(this._renderer.diagnostics.error){this._setMode('css');return;}
        // Restore its CSS box before reading it: a hidden canvas has zero bounds.
        this._setMode('webgl');
        if(this._renderer.render()){
          if(!this._ready&&this._sourceState!=='loading'){this._ready=true;this.dispatchEvent(makeEvent(win,'glass-ready',this.diagnostics));}
          if(this.hasAttribute('continuous'))this.refresh();
        }
      }catch(error){this._gpuError=error;this._setMode('css');this._report(error,'render');}
    }
    get diagnostics(){return {mode:this._mode,source:this._sourceState,sourceError:this._sourceError?.message||null,error:this._gpuError?.message||null,
      surfaces:this._panels.size,renderer:this._renderer?.diagnostics||null,
      materials:[...this._panels].map(p=>({name:p._material?.materialName||null,provenance:p._material?.provenance||null,limitations:p._material?.limitations||[]}))};}
    destroy(){this.disconnectedCallback();}
  }

  class LiquidGlass extends win.HTMLElement {
    static get observedAttributes(){return ['material','radius','interactive','animation','hidden'];}
    constructor(){super();this.attachShadow({mode:'open'}).innerHTML=`<style>${PANEL_STYLE}</style><slot></slot>`;this._options={};this._scene=null;this._material=null;this._interaction=null;this._lastError=null;}
    connectedCallback(){for(const key of ['materialOptions','radius'])if(Object.prototype.hasOwnProperty.call(this,key)){const value=this[key];delete this[key];this[key]=value;}let p=this.parentNode;while(p&&!(p instanceof LiquidGlassScene))p=p.parentNode||p.host;this._scene=p||null;this._scene?._register(this);this._syncInteraction();this._setRadius();if(!p)this._fallback(true,false);}
    disconnectedCallback(){this._scene?._unregister(this);this._scene=null;this._interaction?.destroy();this._interaction=null;}
    attributeChangedCallback(name,oldValue,value){if(oldValue===value)return;if(name==='material')this._material=null;if(name==='radius')this._setRadius();if(name==='interactive'||name==='animation')this._syncInteraction();this._scene?.refresh();}
    get radius(){const n=Number(this.getAttribute('radius')??28);return Number.isFinite(n)&&n>=0?n:28;}
    set radius(value){if(!Number.isFinite(value)||value<0)throw new RangeError('radius must be a finite nonnegative number.');this.setAttribute('radius',String(value));}
    get materialOptions(){return {...this._options};}
    set materialOptions(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('materialOptions must be a plain object.');this._options={...value};this._material=null;this._scene?.refresh();}
    _setRadius(){this.style.setProperty('--liquid-glass-radius',`${this.radius}px`);}
    _syncInteraction(){this._interaction?.destroy();this._interaction=null;if(this.isConnected&&this.hasAttribute('interactive'))try{this._interaction=attachGlassInteraction(this,{animation:this.getAttribute('animation')||'transition',onChange:()=>this._scene?.refresh()});}catch(error){this.dispatchEvent(makeEvent(win,'glass-error',{error,message:error.message,phase:'interaction',mode:this._scene?._mode||'css'}));}}
    _fallback(enabled,opaque){this.toggleAttribute('data-lg-fallback',enabled);this.toggleAttribute('data-lg-opaque',!!opaque);}
    _surface(){
      try{if(!this._material)this._material=createMaterial(this.getAttribute('material')||this._scene?.getAttribute('material')||'clearActive',{...this._scene?._options,...this._options});
        this._lastError=null;this._fallback(false,false);return {...this._material,element:this,radius:this.radius};
      }catch(error){this._fallback(true,false);if(this._lastError!==error.message){this._lastError=error.message;this.dispatchEvent(makeEvent(win,'glass-error',{error,message:error.message,phase:'material',mode:'css'}));}return null;}
    }
  }
  return {LiquidGlassScene,LiquidGlass};
}

return {createGlassElements};
})();

// index.js
const m0=(()=>{
const {createGlassElements}=m1;
const {createMaterial, MATERIAL_NAMES}=m8;
const {attachGlassInteraction}=m11;
const {GlassRenderer}=m2;
const {GLASS_SPRINGS}=m12;
const VERSION='0.1.0';
function defineLiquidGlass(win=typeof window==='undefined'?undefined:window){
  if(!win?.customElements)return null;
  const scene=win.customElements.get('liquid-glass-scene'),panel=win.customElements.get('liquid-glass');
  if(scene||panel){
    if(scene?.liquidGlassVersion===VERSION&&panel?.liquidGlassVersion===VERSION)return {LiquidGlassScene:scene,LiquidGlass:panel};
    throw new Error('The liquid-glass element names are already registered by another version. Load this library once.');
  }
  const classes=createGlassElements(win);
  for(const constructor of Object.values(classes))Object.defineProperty(constructor,'liquidGlassVersion',{value:VERSION});
  win.customElements.define('liquid-glass-scene',classes.LiquidGlassScene);
  win.customElements.define('liquid-glass',classes.LiquidGlass);
  return classes;
}
// Node/SSR imports expose the API without reading or creating a DOM.
if(typeof window!=='undefined'&&window.customElements)defineLiquidGlass(window);

return {VERSION,defineLiquidGlass,createMaterial,MATERIAL_NAMES,attachGlassInteraction,GlassRenderer,GLASS_SPRINGS};
})();
export const {VERSION,defineLiquidGlass,createMaterial,MATERIAL_NAMES,attachGlassInteraction,GlassRenderer,GLASS_SPRINGS}=m0;
