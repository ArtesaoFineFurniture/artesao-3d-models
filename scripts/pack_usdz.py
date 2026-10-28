#!/usr/bin/env python3
"""Pack a glb-to-usdz extract into a Quick Look USDZ and check it with OpenUSD.

The extract directory is written by scripts/glb-to-usdz.mjs. This keeps the
stage in meters and Y-up, binds UsdPreviewSurface materials, and packages the
textures beside the mesh. usdchecker itself is not part of the usd-core wheel;
the same package rules (stored zip entries, 64-byte alignment, stage metadata,
preview-surface normals) are run through UsdValidation.
"""

import hashlib
import json
import os
import sys
import zipfile

import numpy as np
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils, UsdValidation, Vt

MESH_MAGIC = 0x314D4553
BOUNDS_TOLERANCE_M = 0.0005
VALIDATOR_KEYWORDS = {
    "UsdCoreValidators",
    "UsdGeomValidators",
    "UsdShadeValidators",
    "UsdUtilsValidators",
    "UsdzValidators",
}


def read_mesh(path):
    with open(path, "rb") as handle:
        header = np.frombuffer(handle.read(16), dtype="<u4")
        if int(header[0]) != MESH_MAGIC or int(header[1]) != 1:
            raise SystemExit(f"Unexpected mesh header in {path}")
        vertex_count = int(header[2])
        index_count = int(header[3])
        positions = np.frombuffer(handle.read(vertex_count * 3 * 4), dtype="<f4").reshape(vertex_count, 3).copy()
        normals = np.frombuffer(handle.read(vertex_count * 3 * 4), dtype="<f4").reshape(vertex_count, 3).copy()
        uvs = np.frombuffer(handle.read(vertex_count * 2 * 4), dtype="<f4").reshape(vertex_count, 2).copy()
        indices = np.frombuffer(handle.read(index_count * 4), dtype="<u4").copy()
    if indices.size != index_count or indices.size % 3 != 0:
        raise SystemExit(f"Incomplete triangles in {path}")
    return positions, normals, uvs, indices


def add_reader(stage, material_path):
    reader = UsdShade.Shader.Define(stage, f"{material_path}/PrimvarReader")
    reader.CreateIdAttr("UsdPrimvarReader_float2")
    reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
    reader.CreateOutput("result", Sdf.ValueTypeNames.Float2)
    return reader


def add_texture(stage, material_path, shader_name, spec, reader, scale=None, bias=None):
    shader = UsdShade.Shader.Define(stage, f"{material_path}/{shader_name}")
    shader.CreateIdAttr("UsdUVTexture")
    # A leading ./ keeps the path relative to the USD layer. Without it, the
    # package tool treats the first directory as a search-path anchor.
    asset_path = spec["file"] if str(spec["file"]).startswith("./") else f"./{spec['file']}"
    shader.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(asset_path))
    shader.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set(spec["colorSpace"])
    shader.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set(spec["wrapS"])
    shader.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set(spec["wrapT"])
    shader.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.GetOutput("result"))
    if scale is not None:
        shader.CreateInput("scale", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*scale))
    if bias is not None:
        shader.CreateInput("bias", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*bias))
    shader.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
    shader.CreateOutput("r", Sdf.ValueTypeNames.Float)
    shader.CreateOutput("g", Sdf.ValueTypeNames.Float)
    shader.CreateOutput("b", Sdf.ValueTypeNames.Float)
    return shader


def build_material(stage, material):
    material_path = f"/Materials/{material['name']}"
    usd_material = UsdShade.Material.Define(stage, material_path)
    reader = add_reader(stage, material_path)
    surface = UsdShade.Shader.Define(stage, f"{material_path}/PreviewSurface")
    surface.CreateIdAttr("UsdPreviewSurface")
    surface.CreateInput("useSpecularWorkflow", Sdf.ValueTypeNames.Int).Set(0)
    surface.CreateOutput("surface", Sdf.ValueTypeNames.Token)

    factor = material["baseColorFactor"]
    if material.get("baseColor"):
        scale = None
        if any(abs(channel - 1.0) > 1e-6 for channel in factor[:3]):
            scale = (float(factor[0]), float(factor[1]), float(factor[2]), 1.0)
        texture = add_texture(stage, material_path, "BaseColor", material["baseColor"], reader, scale)
        surface.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(texture.GetOutput("rgb"))
    else:
        surface.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(
            Gf.Vec3f(float(factor[0]), float(factor[1]), float(factor[2]))
        )

    if material.get("metallicRoughness"):
        # glTF stores roughness in G and metallic in B. Factors multiply those channels.
        texture = add_texture(
            stage,
            material_path,
            "MetallicRoughness",
            material["metallicRoughness"],
            reader,
            (1.0, float(material["roughnessFactor"]), float(material["metallicFactor"]), 1.0),
        )
        surface.CreateInput("roughness", Sdf.ValueTypeNames.Float).ConnectToSource(texture.GetOutput("g"))
        surface.CreateInput("metallic", Sdf.ValueTypeNames.Float).ConnectToSource(texture.GetOutput("b"))
    else:
        surface.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(float(material["roughnessFactor"]))
        surface.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(float(material["metallicFactor"]))

    if material.get("normal"):
        # Preview Surface wants the normal in [-1, 1]. An 8-bit map is decoded here.
        texture = add_texture(
            stage,
            material_path,
            "Normal",
            material["normal"],
            reader,
            (2.0, 2.0, 2.0, 1.0),
            (-1.0, -1.0, -1.0, 0.0),
        )
        surface.CreateInput("normal", Sdf.ValueTypeNames.Normal3f).ConnectToSource(texture.GetOutput("rgb"))

    surface.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(float(factor[3]))
    usd_material.CreateSurfaceOutput().ConnectToSource(surface.GetOutput("surface"))
    return usd_material


def build_mesh(stage, mesh_meta, usd_material, workdir):
    positions, normals, uvs, indices = read_mesh(os.path.join(workdir, mesh_meta["bin"]))
    mesh = UsdGeom.Mesh.Define(stage, f"/Root/{mesh_meta['name']}")
    mesh.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(positions))
    mesh.CreateNormalsAttr(Vt.Vec3fArray.FromNumpy(normals))
    mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    counts = np.full(indices.size // 3, 3, dtype=np.int32)
    mesh.CreateFaceVertexCountsAttr(Vt.IntArray.FromNumpy(counts))
    mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(indices.astype(np.int32)))
    mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    mesh.CreateOrientationAttr(UsdGeom.Tokens.rightHanded)
    mesh.CreateDoubleSidedAttr(bool(mesh_meta["doubleSided"]))
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    mesh.CreateExtentAttr(Vt.Vec3fArray([
        Gf.Vec3f(float(minimum[0]), float(minimum[1]), float(minimum[2])),
        Gf.Vec3f(float(maximum[0]), float(maximum[1]), float(maximum[2])),
    ]))
    primvar = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar(
        "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex
    )
    primvar.Set(Vt.Vec2fArray.FromNumpy(uvs))
    prim = mesh.GetPrim()
    UsdShade.MaterialBindingAPI.Apply(prim)
    UsdShade.MaterialBindingAPI(prim).Bind(usd_material)
    return positions


def package(usdc_path, output):
    if os.path.exists(output):
        os.remove(output)
    arkit = bool(UsdUtils.CreateNewARKitUsdzPackage(usdc_path, output))
    if arkit and os.path.exists(output):
        return True
    if os.path.exists(output):
        os.remove(output)
    if not UsdUtils.CreateNewUsdzPackage(usdc_path, output):
        raise SystemExit("OpenUSD could not create the USDZ package.")
    return False


def zip_entries(path):
    data = open(path, "rb").read()
    entries = []
    offset = 0
    while offset + 4 <= len(data) and data[offset:offset + 4] == b"PK\x03\x04":
        flags = int.from_bytes(data[offset + 6:offset + 8], "little")
        method = int.from_bytes(data[offset + 8:offset + 10], "little")
        comp_size = int.from_bytes(data[offset + 18:offset + 22], "little")
        name_len = int.from_bytes(data[offset + 26:offset + 28], "little")
        extra_len = int.from_bytes(data[offset + 28:offset + 30], "little")
        name = data[offset + 30:offset + 30 + name_len].decode("utf-8", "replace")
        start = offset + 30 + name_len + extra_len
        entries.append({
            "name": name,
            "method": method,
            "flags": flags,
            "start": start,
            "comp_size": comp_size,
        })
        if flags & 0x8:
            raise SystemExit(f"{name} uses a zip data descriptor, so alignment could not be checked.")
        offset = start + comp_size
    if not entries:
        raise SystemExit("The USDZ package has no zip entries.")
    return entries


def error_text(error):
    for name in ("GetMessage", "GetErrorMessage", "message"):
        value = getattr(error, name, None)
        if value is None:
            continue
        text = value() if callable(value) else value
        if text:
            return str(text)
    return str(error)


def run_validators(usdz_path):
    registry = UsdValidation.ValidationRegistry()
    names = []
    for item in registry.GetAllValidatorMetadata():
        if item.isSuite:
            continue
        if VALIDATOR_KEYWORDS.intersection(item.GetKeywords()):
            names.append(item.name)
    validators = registry.GetOrLoadValidatorsByName(names)
    context = UsdValidation.ValidationContext(validators)
    stage = Usd.Stage.Open(usdz_path)
    try:
        result = context.Validate(stage)
    except Exception:
        result = context.Validate(usdz_path)
    if not result:
        return []
    if isinstance(result, (str, bytes)):
        return [str(result)]
    return [error_text(error) for error in result]


def shader_id(prim):
    shader = UsdShade.Shader(prim)
    identifier = shader.GetIdAttr().Get()
    return str(identifier) if identifier else ""


def validate(usdz_path, meta, arkit):
    errors = []
    stage = Usd.Stage.Open(usdz_path)
    if not stage:
        return {"ok": False, "errors": ["OpenUSD could not open the USDZ."]}

    meters = float(UsdGeom.GetStageMetersPerUnit(stage))
    up_axis = str(UsdGeom.GetStageUpAxis(stage))
    if abs(meters - 1.0) > 1e-6:
        errors.append(f"metersPerUnit is {meters}, expected 1.")
    if up_axis != "Y":
        errors.append(f"upAxis is {up_axis}, expected Y.")
    default_prim = stage.GetDefaultPrim()
    if not default_prim or default_prim.GetPath() != "/Root":
        errors.append("defaultPrim is not /Root.")

    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    aligned = cache.ComputeWorldBound(stage.GetPseudoRoot()).ComputeAlignedRange()
    minimum = [aligned.GetMin()[axis] * meters for axis in range(3)]
    maximum = [aligned.GetMax()[axis] * meters for axis in range(3)]
    expected_min = meta["bounds"]["min"]
    expected_max = meta["bounds"]["max"]
    for axis, label in enumerate("xyz"):
        if abs(minimum[axis] - expected_min[axis]) > BOUNDS_TOLERANCE_M or abs(maximum[axis] - expected_max[axis]) > BOUNDS_TOLERANCE_M:
            errors.append(
                f"bounds {label} are {minimum[axis]:.5f}..{maximum[axis]:.5f}, "
                f"GLB is {expected_min[axis]:.5f}..{expected_max[axis]:.5f}"
            )

    entries = zip_entries(usdz_path)
    packaged = {}
    with zipfile.ZipFile(usdz_path) as archive:
        for entry in entries:
            if entry["method"] != zipfile.ZIP_STORED:
                errors.append(f"{entry['name']} is compressed. Quick Look requires stored zip entries.")
            if entry["start"] % 64 != 0:
                errors.append(f"{entry['name']} starts at byte {entry['start']}, not a 64-byte boundary.")
            packaged[entry["name"].replace("\\", "/")] = archive.read(entry["name"])

    usd_layers = [name for name in packaged if name.endswith((".usd", ".usda", ".usdc"))]
    if not usd_layers:
        errors.append("The package has no USD layer.")

    for texture in meta["textures"]:
        base = os.path.basename(texture["file"])
        matches = [name for name in packaged if os.path.basename(name) == base]
        if len(matches) != 1:
            errors.append(f"Expected one packaged copy of {texture['file']}, found {matches}.")
            continue
        digest = hashlib.sha256(packaged[matches[0]]).hexdigest()
        if digest != texture["sha256"]:
            errors.append(f"Packaged bytes for {texture['file']} do not match the PNG written from the GLB.")

    roles = {texture["file"]: texture for texture in meta["textures"]}
    preview_count = 0
    texture_count = 0
    for prim in stage.Traverse():
        if not prim.IsA(UsdShade.Shader):
            continue
        identifier = shader_id(prim)
        shader = UsdShade.Shader(prim)
        if identifier == "UsdPreviewSurface":
            preview_count += 1
            if shader.GetInput("useSpecularWorkflow").Get() != 0:
                errors.append(f"{prim.GetPath()} is not using the metallic workflow.")
        if identifier != "UsdUVTexture":
            continue
        texture_count += 1
        asset = shader.GetInput("file").Get()
        asset_path = str(asset.path if asset else "").replace("\\", "/")
        spec = roles.get(asset_path[2:] if asset_path.startswith("./") else asset_path)
        if spec is None:
            base = os.path.basename(asset_path)
            spec = next((item for item in meta["textures"] if os.path.basename(item["file"]) == base), None)
        if spec is None:
            errors.append(f"{prim.GetPath()} points at {asset_path}, which is not one of the GLB textures.")
            continue
        color_space = str(shader.GetInput("sourceColorSpace").Get())
        if color_space != spec["colorSpace"]:
            errors.append(f"{asset_path} color space is {color_space}, expected {spec['colorSpace']}.")
        if spec["role"] == "normal":
            scale = shader.GetInput("scale").Get()
            bias = shader.GetInput("bias").Get()
            expected_scale = Gf.Vec4f(2, 2, 2, 1)
            expected_bias = Gf.Vec4f(-1, -1, -1, 0)
            if scale != expected_scale or bias != expected_bias:
                errors.append(f"{asset_path} normal map is missing the [-1, 1] scale and bias.")
            if color_space != "raw":
                errors.append(f"{asset_path} normal map is not raw.")

    if preview_count != len(meta["materials"]):
        errors.append(f"Found {preview_count} preview surfaces for {len(meta['materials'])} materials.")
    if texture_count != sum(1 for material in meta["materials"] for key in ("baseColor", "metallicRoughness", "normal") if material.get(key)):
        errors.append("The number of USD textures does not match the GLB materials.")

    errors.extend(run_validators(usdz_path))
    return {
        "ok": not errors,
        "errors": errors,
        "arkit": arkit,
        "metersPerUnit": meters,
        "upAxis": up_axis,
        "boundsMin": minimum,
        "boundsMax": maximum,
        "bytes": os.path.getsize(usdz_path),
        "textureCount": len(meta["textures"]),
        "entries": list(packaged.keys()),
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: pack_usdz.py <workdir> <output.usdz>")
    workdir, output = sys.argv[1], sys.argv[2]
    with open(os.path.join(workdir, "meta.json"), encoding="utf-8") as handle:
        meta = json.load(handle)

    usdc_path = os.path.join(workdir, "model.usdc")
    stage = Usd.Stage.CreateNew(usdc_path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    root = UsdGeom.Xform.Define(stage, "/Root")
    stage.SetDefaultPrim(root.GetPrim())
    # Quick Look uses these tokens when it chooses a floor plane.
    root.GetPrim().CreateAttribute("preliminary:anchoring:type", Sdf.ValueTypeNames.Token).Set("plane")
    root.GetPrim().CreateAttribute(
        "preliminary:planeAnchoring:alignment", Sdf.ValueTypeNames.Token
    ).Set("horizontal")
    UsdGeom.Scope.Define(stage, "/Materials")

    materials = {}
    for material in meta["materials"]:
        materials[material["name"]] = build_material(stage, material)
    for mesh_meta in meta["meshes"]:
        build_mesh(stage, mesh_meta, materials[mesh_meta["material"]], workdir)
    stage.GetRootLayer().Save()

    arkit = package(usdc_path, output)
    report = validate(output, meta, arkit)
    json.dump(report, sys.stdout)
    sys.stdout.write("\n")
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
