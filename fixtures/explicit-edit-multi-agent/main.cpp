#include "yocto_trace.h"

#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>

// Generate two small scenes with different geometry, camera and material paths.
static yocto::scene_data make_scene(int variant) {
  using namespace yocto;
  auto scene = scene_data{};
  auto camera = camera_data{};
  camera.frame = lookat_frame({3, 2, 4}, {0, 0.6f, 0}, {0, 1, 0});
  camera.aspect = 1;
  scene.cameras.push_back(camera);
  auto ground = material_data{};
  ground.color = {0.65f, 0.65f, 0.65f};
  scene.materials.push_back(ground);
  auto object = material_data{};
  object.type = variant == 0 ? material_type::matte : material_type::glossy;
  object.color = variant == 0 ? vec3f{0.8f, 0.15f, 0.1f} : vec3f{0.1f, 0.3f, 0.8f};
  object.roughness = 0.2f;
  scene.materials.push_back(object);
  auto light = material_data{};
  light.emission = {12, 10, 8};
  scene.materials.push_back(light);
  scene.shapes.push_back(make_floor({1, 1}, {3, 3}));
  scene.shapes.push_back(variant == 0 ? make_uvsphere({16, 8}, 0.6f) : make_box({1, 1, 1}, {0.5f, 0.7f, 0.5f}));
  scene.shapes.push_back(make_rect({1, 1}, {0.7f, 0.7f}));
  scene.instances.push_back({identity3x4f, 0, 0});
  auto object_frame = identity3x4f;
  object_frame.o = {0, 0.7f, 0};
  scene.instances.push_back({object_frame, 1, 1});
  auto light_frame = lookat_frame({0, 3, 0}, {0, 0, 0}, {0, 0, 1});
  scene.instances.push_back({light_frame, 2, 2});
  auto environment = environment_data{};
  environment.emission = {0.15f, 0.15f, 0.15f};
  scene.environments.push_back(environment);
  return scene;
}

// Write exact float pixel data for the oracle and a PPM preview for a human.
static void render_scene(int variant, const std::string& prefix) {
  auto params = yocto::trace_params{};
  params.resolution = 32;
  params.samples = 8;
  params.bounces = 4;
  params.seed = 961748941ull + variant;
  params.noparallel = true;
  auto image = yocto::trace_image(make_scene(variant), params);
  auto raw = std::ofstream(prefix + ".rgba32f", std::ios::binary);
  auto preview = std::ofstream(prefix + ".ppm", std::ios::binary);
  if (!raw || !preview) throw std::runtime_error("Cannot open image outputs");
  preview << "P6\n" << image.width << " " << image.height << "\n255\n";
  for (auto pixel : image.pixels) {
    const float channels[] = {pixel.x, pixel.y, pixel.z, pixel.w};
    for (auto value : channels) {
      if (!std::isfinite(value)) throw std::runtime_error("Non-finite rendered pixel");
      raw.write(reinterpret_cast<const char*>(&value), sizeof(value));
    }
    for (auto value : {pixel.x, pixel.y, pixel.z}) {
      auto mapped = std::pow(value / (1 + value), 1 / 2.2f);
      auto byte = static_cast<unsigned char>(yocto::clamp(mapped, 0.0f, 1.0f) * 255 + 0.5f);
      preview.write(reinterpret_cast<const char*>(&byte), 1);
    }
  }
  if (!raw || !preview) throw std::runtime_error("Cannot write image outputs");
}

int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("Usage: renderer OUTPUT_PREFIX");
    for (auto variant = 0; variant != 2; ++variant) {
      render_scene(variant, std::string(argv[1]) + "-" + std::to_string(variant));
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
