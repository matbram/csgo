/** Post-processing pipeline: ACES tone mapping, bloom, FXAA, vignette, sharpen.
 *  Wired to the scene's active camera. The pipeline is created after the
 *  player camera exists so that `cameras` references are valid. */

// Side-effect: register the post-process pipeline manager scene component.
// Without this, `scene.postProcessRenderPipelineManager` is undefined and
// constructing any pipeline throws.
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent';

import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { getScene } from './scene';

let pipeline: DefaultRenderingPipeline | null = null;

export function createPostFx(camera: Camera): DefaultRenderingPipeline {
  if (pipeline) return pipeline;
  const scene = getScene();
  pipeline = new DefaultRenderingPipeline('default', true, scene, [camera]);

  // Tone mapping
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.0;
  pipeline.imageProcessing.contrast = 1.05;
  // Warm color grading via vignette + small offsets.
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 1.0;
  pipeline.imageProcessing.vignetteStretch = 0.4;
  pipeline.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);
  // Bloom
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.85;
  pipeline.bloomWeight = 0.3;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  // FXAA (cheap edge AA, on top of MSAA when supported).
  pipeline.fxaaEnabled = true;
  // Sharpen
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.25;
  pipeline.sharpen.colorAmount = 1.0;
  // No DoF, no motion blur, no chromatic aberration, no SSR. By design.
  pipeline.depthOfFieldEnabled = false;
  pipeline.chromaticAberrationEnabled = false;
  pipeline.grainEnabled = false;

  // MSAA where the engine supports it.
  try {
    pipeline.samples = 4;
  } catch {
    // ignore — single-sample is fine.
  }

  return pipeline;
}

export function getPostFx(): DefaultRenderingPipeline | null {
  return pipeline;
}
