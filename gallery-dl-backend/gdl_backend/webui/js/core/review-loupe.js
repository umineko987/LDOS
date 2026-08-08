"use strict";

/**
 * REVIEW.EXE 镜片与比较布局的纯数学内核。
 *
 * 这里的输入只接受脱敏后的数值资料，所有计算结果都保持有限且可冻结。
 * 不在此处读取页面环境，也不持有媒体、持久化或请求相关对象。
 */

export const REFERENCE_PIXEL_HEIGHT = 160;
export const LOUPE_REFERENCE_HEIGHT = REFERENCE_PIXEL_HEIGHT;
export const MIN_MAGNIFICATION = 0.25;
export const MAX_MAGNIFICATION = 1.0;
export const DEFAULT_MAGNIFICATION = 0.5;
export const MIN_LAYOUT_RATIO = 0.38;
export const MAX_LAYOUT_RATIO = 2.6;
export const DEFAULT_LAYOUT_GAP = 12;
export const DEFAULT_DESKTOP_MIN_SHORT_EDGE = 160;
export const DEFAULT_NARROW_MIN_SHORT_EDGE = 112;
export const MAGNIFICATION_STEP_BASE = 1.18;

const MAX_IMAGE_DIMENSION = 1_000_000_000;
const MIN_TILE_SIZE = 1;
const LABEL_MAX_EPSILON = 0.001;

function freezeResult(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeResult(child);
  return Object.freeze(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredFiniteNumber(value, label) {
  if (!isFiniteNumber(value)) throw new TypeError(`${label}必须是有限数字`);
  return value;
}

function positiveNumber(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  requiredFiniteNumber(value, label);
  if (value <= 0 || value > maximum) throw new RangeError(`${label}必须大于零且在安全范围内`);
  return value;
}

function nonNegativeNumber(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  requiredFiniteNumber(value, label);
  if (value < 0 || value > maximum) throw new RangeError(`${label}不得为负且必须在安全范围内`);
  return value;
}

/* 只读取普通数据对象，避免访问器或异常代理把不确定值带入计算。 */
function dataDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return null;
      }
    }
    return descriptors;
  } catch {
    return null;
  }
}

function requiredDataDescriptors(value, label) {
  const descriptors = dataDescriptors(value);
  if (!descriptors) throw new TypeError(`${label}必须是普通数据对象`);
  return descriptors;
}

function ownField(descriptors, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(descriptors, name)) {
      return { found: true, value: descriptors[name].value };
    }
  }
  return { found: false, value: undefined };
}

function positiveDimensionFrom(descriptors, metadata, names) {
  const direct = ownField(descriptors, names);
  const candidate = direct.found ? direct : metadata ? ownField(metadata, names) : direct;
  if (!candidate.found || !isFiniteNumber(candidate.value)) return null;
  if (candidate.value <= 0 || candidate.value > MAX_IMAGE_DIMENSION) return null;
  return candidate.value;
}

function booleanField(descriptors, name, fallback) {
  const field = ownField(descriptors, [name]);
  if (!field.found) return fallback;
  return typeof field.value === "boolean" ? field.value : null;
}

function normalizePair(widthValue, heightValue, readable = true, recommended = false) {
  const width = isFiniteNumber(widthValue)
    && widthValue > 0
    && widthValue <= MAX_IMAGE_DIMENSION
    ? widthValue
    : null;
  const height = isFiniteNumber(heightValue)
    && heightValue > 0
    && heightValue <= MAX_IMAGE_DIMENSION
    ? heightValue
    : null;
  if (width === null || height === null) return null;
  if (typeof readable !== "boolean" || typeof recommended !== "boolean") return null;
  return freezeResult({ width, height, readable, recommended });
}

/**
 * 规范化一张图片的自然尺寸。无效尺寸返回 null；不可读但尺寸完整的图片
 * 会保留 readable=false，供布局保留占位而不被选作参考或取样目标。
 */
export function normalizeImageDimensions(value, heightValue) {
  if (arguments.length > 1) return normalizePair(value, heightValue);
  const descriptors = dataDescriptors(value);
  if (!descriptors) return null;

  const metadataField = ownField(descriptors, ["metadata"]);
  const metadata = metadataField.found ? dataDescriptors(metadataField.value) : null;
  const width = positiveDimensionFrom(
    descriptors,
    metadata,
    ["width", "w", "naturalWidth"],
  );
  const height = positiveDimensionFrom(
    descriptors,
    metadata,
    ["height", "h", "naturalHeight"],
  );
  if (width === null || height === null) return null;

  const readable = booleanField(descriptors, "readable", true);
  const recommended = booleanField(descriptors, "recommended", false);
  if (readable === null || recommended === null) return null;
  return freezeResult({ width, height, readable, recommended });
}

export const normalizeDimensions = normalizeImageDimensions;
export const normalizeImageSize = normalizeImageDimensions;

/**
 * 有界夹取。边界和值都必须是有限数字，且下界不得高于上界。
 */
export function clamp(value, minimum, maximum) {
  requiredFiniteNumber(value, "待夹取值");
  requiredFiniteNumber(minimum, "下界");
  requiredFiniteNumber(maximum, "上界");
  if (minimum > maximum) throw new RangeError("夹取范围无效");
  return Math.min(maximum, Math.max(minimum, value));
}

export const boundedClamp = clamp;

/**
 * 对有限数字求确定性中位数。偶数个样本沿用 demo 的上中位数语义，
 * 无有效样本返回 null；输入数组不会被修改。
 */
export function median(values) {
  if (!Array.isArray(values)) throw new TypeError("中位数输入必须是数组");
  const ordered = values.filter(isFiniteNumber).sort((left, right) => left - right);
  if (!ordered.length) return null;
  return ordered[Math.floor(ordered.length / 2)];
}

function normalizedEntries(images) {
  if (!Array.isArray(images)) throw new TypeError("图片列表必须是数组");
  const entries = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = normalizeImageDimensions(images[index]);
    if (image) entries.push({ index, image });
  }
  return entries;
}

function readableEntries(images) {
  return normalizedEntries(images).filter((entry) => entry.image.readable);
}

/**
 * 选择镜片参考图：可读推荐图优先，否则使用第一张可读图。
 * 返回值始终是明确的可用/不可用结果，不暴露调用方原始对象。
 */
export function selectReferenceImage(images) {
  const readable = readableEntries(images);
  if (!readable.length) {
    return freezeResult({ available: false, index: -1, image: null });
  }
  const selected = readable.find((entry) => entry.image.recommended) || readable[0];
  return freezeResult({ available: true, index: selected.index, image: selected.image });
}

export const chooseReferenceImage = selectReferenceImage;
export const findReferenceImage = selectReferenceImage;
export const getReferenceImageResult = selectReferenceImage;

/** 兼容 demo 风格的直接取图接口；没有可读图时返回 null。 */
export function referenceImage(images) {
  const result = selectReferenceImage(images);
  return result.available ? result.image : null;
}

function layoutOption(descriptors, names) {
  return ownField(descriptors, names);
}

function resolveLayoutArguments(imagesOrInput, widthOrOptions, heightValue, gapValue, edgeValue) {
  let images = imagesOrInput;
  let options = null;
  let width = widthOrOptions;
  let height = heightValue;
  let gap = gapValue;
  let minimumShortEdge = edgeValue;

  const inputDescriptors = dataDescriptors(imagesOrInput);
  if (inputDescriptors && Object.prototype.hasOwnProperty.call(inputDescriptors, "images") &&
      widthOrOptions === undefined) {
    images = inputDescriptors.images.value;
    options = inputDescriptors;
  } else {
    const optionDescriptors = dataDescriptors(widthOrOptions);
    if (optionDescriptors && heightValue === undefined) {
      options = optionDescriptors;
      width = undefined;
      height = undefined;
      gap = undefined;
      minimumShortEdge = undefined;
    }
  }

  if (options) {
    const widthField = layoutOption(options, ["availableWidth", "stageWidth", "width"]);
    const heightField = layoutOption(options, ["availableHeight", "stageHeight", "height"]);
    const gapField = layoutOption(options, ["gap"]);
    const edgeField = layoutOption(options, [
      "minimumShortEdge",
      "minimumShortSide",
      "minShortEdge",
      "minimumEdge",
      "minEdge",
    ]);
    width = widthField.found ? widthField.value : width;
    height = heightField.found ? heightField.value : height;
    gap = gapField.found ? gapField.value : gap;
    minimumShortEdge = edgeField.found ? edgeField.value : minimumShortEdge;
  }

  const availableWidth = positiveNumber(width, "舞台可用宽度", MAX_IMAGE_DIMENSION);
  const availableHeight = positiveNumber(height, "舞台可用高度", MAX_IMAGE_DIMENSION);
  const resolvedGap = gap === undefined
    ? DEFAULT_LAYOUT_GAP
    : nonNegativeNumber(gap, "布局间距", MAX_IMAGE_DIMENSION);
  const resolvedEdge = minimumShortEdge === undefined
    ? (availableWidth < 700 ? DEFAULT_NARROW_MIN_SHORT_EDGE : DEFAULT_DESKTOP_MIN_SHORT_EDGE)
    : positiveNumber(minimumShortEdge, "最小短边", MAX_IMAGE_DIMENSION);
  return { images, availableWidth, availableHeight, gap: resolvedGap, minimumShortEdge: resolvedEdge };
}

function unavailableLayout() {
  return freezeResult({
    columns: 0,
    rows: 0,
    tileWidth: 0,
    tileHeight: 0,
    ratio: 1,
    readable: false,
  });
}

function layoutCandidate(columns, count, width, height, gap, ratio, minimumShortEdge) {
  const rows = Math.ceil(count / columns);
  const rawCellWidth = (width - gap * (columns - 1)) / columns;
  const rawCellHeight = (height - gap * (rows - 1)) / rows;
  if (!isFiniteNumber(rawCellWidth) || !isFiniteNumber(rawCellHeight)) return null;

  // 空间不足时保留最小正尺寸，让上层通过滚动承载，而不是产生负尺寸。
  const cellWidth = Math.max(MIN_TILE_SIZE, rawCellWidth);
  const cellHeight = Math.max(MIN_TILE_SIZE, rawCellHeight);
  const limitedWidth = Math.min(cellWidth, cellHeight * ratio);
  if (!isFiniteNumber(limitedWidth) || limitedWidth <= 0) return null;
  const tileWidth = Math.max(MIN_TILE_SIZE, limitedWidth);
  const tileHeight = tileWidth / ratio;
  if (!isFiniteNumber(tileHeight) || tileHeight <= 0) return null;
  const area = tileWidth * tileHeight;
  if (!isFiniteNumber(area) || area <= 0) return null;
  return {
    columns,
    rows,
    tileWidth,
    tileHeight,
    readable: Math.min(tileWidth, tileHeight) >= minimumShortEdge,
    area,
  };
}

function isBetterLayout(candidate, best) {
  if (!best) return true;
  if (candidate.readable !== best.readable) return candidate.readable;
  if (candidate.area !== best.area) return candidate.area > best.area;
  if (candidate.tileWidth !== best.tileWidth) return candidate.tileWidth > best.tileWidth;
  if (candidate.tileHeight !== best.tileHeight) return candidate.tileHeight > best.tileHeight;
  if (candidate.columns !== best.columns) return candidate.columns < best.columns;
  return candidate.rows < best.rows;
}

/**
 * 计算比较舞台布局。支持 chooseLayout(images, width, height, gap, edge)
 * 与单对象参数两种形式；图片数量只由有效尺寸项决定，不限制为四张。
 */
export function calculateReviewLayout(
  imagesOrInput,
  widthOrOptions,
  heightValue,
  gapValue,
  edgeValue,
) {
  const { images, availableWidth, availableHeight, gap, minimumShortEdge } =
    resolveLayoutArguments(imagesOrInput, widthOrOptions, heightValue, gapValue, edgeValue);
  const entries = normalizedEntries(images);
  if (!entries.length) return unavailableLayout();

  const ratios = entries
    .filter((entry) => entry.image.readable)
    .map((entry) => entry.image.width / entry.image.height);
  const sampleMedian = median(ratios);
  const ratio = clamp(
    sampleMedian === null ? 1 : sampleMedian,
    MIN_LAYOUT_RATIO,
    MAX_LAYOUT_RATIO,
  );
  const hasReadableImage = ratios.length > 0;
  let best = null;
  for (let columns = 1; columns <= entries.length; columns += 1) {
    const candidate = layoutCandidate(
      columns,
      entries.length,
      availableWidth,
      availableHeight,
      gap,
      ratio,
      minimumShortEdge,
    );
    if (candidate && isBetterLayout(candidate, best)) best = candidate;
  }
  if (!best) return unavailableLayout();
  return freezeResult({
    columns: best.columns,
    rows: best.rows,
    tileWidth: best.tileWidth,
    tileHeight: best.tileHeight,
    ratio,
    readable: Boolean(hasReadableImage && best.readable),
  });
}

export const chooseLayout = calculateReviewLayout;
export const chooseReviewLayout = calculateReviewLayout;
export const computeReviewLayout = calculateReviewLayout;

function normalizeContainerRect(value) {
  const descriptors = dataDescriptors(value);
  if (!descriptors) return null;
  const leftField = ownField(descriptors, ["left", "x"]);
  const topField = ownField(descriptors, ["top", "y"]);
  const widthField = ownField(descriptors, ["width", "w"]);
  const heightField = ownField(descriptors, ["height", "h"]);
  const left = leftField.found ? leftField.value : 0;
  const top = topField.found ? topField.value : 0;
  if (!isFiniteNumber(left) || !isFiniteNumber(top)) return null;
  if (!widthField.found || !heightField.found) return null;
  if (!isFiniteNumber(widthField.value) || !isFiniteNumber(heightField.value)) return null;
  if (widthField.value <= 0 || heightField.value <= 0) return null;
  return { left, top, width: widthField.value, height: heightField.value };
}

function normalizeGeometryImage(value) {
  const image = normalizeImageDimensions(value);
  if (!image || !image.readable) return null;
  return image;
}

function unwrapImageValue(value) {
  const descriptors = dataDescriptors(value);
  if (descriptors && Object.prototype.hasOwnProperty.call(descriptors, "image")) {
    const available = ownField(descriptors, ["available"]);
    if (!available.found || available.value === true) return descriptors.image.value;
  }
  return value;
}

/**
 * 根据自然尺寸和容器矩形计算 contain 后的实际内容区域。
 * 尺寸未就绪或图片不可读时返回 null。
 */
export function getContainContentRect(imageValue, containerValue, ...numericArgs) {
  let image = imageValue;
  let container = containerValue;
  if (isFiniteNumber(imageValue)) {
    image = { width: imageValue, height: containerValue };
    container = {
      left: numericArgs[2] ?? 0,
      top: numericArgs[3] ?? 0,
      width: numericArgs[0],
      height: numericArgs[1],
    };
  } else {
    const config = dataDescriptors(imageValue);
    if (config && Object.prototype.hasOwnProperty.call(config, "image") &&
        Object.prototype.hasOwnProperty.call(config, "container")) {
      image = config.image.value;
      container = config.container.value;
    }
  }
  const dimensions = normalizeGeometryImage(unwrapImageValue(image));
  const rect = normalizeContainerRect(container);
  if (!dimensions || !rect) return null;
  const scale = Math.min(rect.width / dimensions.width, rect.height / dimensions.height);
  if (!isFiniteNumber(scale) || scale <= 0) return null;
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  if (![left, top, width, height].every((value) => isFiniteNumber(value) && value > 0)) {
    // left/top 可能合法为零，因此单独检查偏移的有限性。
    if (!isFiniteNumber(left) || !isFiniteNumber(top)) return null;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
  }
  return freezeResult({ left, top, width, height });
}

export const containContentRect = getContainContentRect;
export const renderedContentRect = getContainContentRect;
export const calculateContainRect = getContainContentRect;
export const getContentRect = getContainContentRect;

function normalizePoint(value, yValue) {
  if (isFiniteNumber(value)) return { x: value, y: yValue };
  const descriptors = dataDescriptors(value);
  if (!descriptors) return null;
  const xField = ownField(descriptors, ["x", "clientX", "pointerX"]);
  const yField = ownField(descriptors, ["y", "clientY", "pointerY"]);
  if (!xField.found || !yField.found) return null;
  return { x: xField.value, y: yField.value };
}

/** 将指针映射到 contain 内容区域，并把边外坐标夹到 0..1。 */
export function normalizePointerCoordinates(pointOrX, yOrRect, rectValue) {
  let pointValue = pointOrX;
  let contentValue = yOrRect;
  if (isFiniteNumber(pointOrX)) {
    pointValue = { x: pointOrX, y: yOrRect };
    contentValue = rectValue;
  } else {
    const config = dataDescriptors(pointOrX);
    if (config && Object.prototype.hasOwnProperty.call(config, "point") &&
        Object.prototype.hasOwnProperty.call(config, "contentRect")) {
      pointValue = config.point.value;
      contentValue = config.contentRect.value;
    }
  }
  const point = normalizePoint(pointValue);
  const content = normalizeContainerRect(contentValue);
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y) || !content) {
    throw new TypeError("指针或内容区域无效");
  }
  return freezeResult({
    u: clamp((point.x - content.left) / content.width, 0, 1),
    v: clamp((point.y - content.top) / content.height, 0, 1),
  });
}

export const pointerToUv = normalizePointerCoordinates;
export const normalizePointer = normalizePointerCoordinates;
export const pointToUv = normalizePointerCoordinates;

function normalizeCropImage(value, label) {
  const image = normalizeImageDimensions(unwrapImageValue(value));
  if (!image) throw new TypeError(`${label}尺寸无效`);
  return image;
}

function cropField(descriptors, names) {
  return ownField(descriptors, names);
}

function parseOutputShape(config, positionalWidth, positionalHeight) {
  let widthValue = positionalWidth;
  let heightValue = positionalHeight;
  let aspectValue;
  if (config) {
    const outputField = cropField(config, ["output", "lens", "destination"]);
    const outputDescriptors = outputField.found ? dataDescriptors(outputField.value) : null;
    const widthField = cropField(config, [
      "outputWidth",
      "lensWidth",
      "destinationWidth",
      "cssWidth",
    ]);
    const heightField = cropField(config, [
      "outputHeight",
      "lensHeight",
      "destinationHeight",
      "cssHeight",
    ]);
    if (widthField.found) widthValue = widthField.value;
    else if (outputDescriptors) {
      const nestedWidth = cropField(outputDescriptors, ["width", "w"]);
      if (nestedWidth.found) widthValue = nestedWidth.value;
    }
    if (heightField.found) heightValue = heightField.value;
    else if (outputDescriptors) {
      const nestedHeight = cropField(outputDescriptors, ["height", "h"]);
      if (nestedHeight.found) heightValue = nestedHeight.value;
    }
    const aspectField = cropField(config, ["outputAspectRatio", "lensAspectRatio", "aspectRatio"]);
    if (aspectField.found) aspectValue = aspectField.value;
  }

  if (widthValue === undefined && heightValue === undefined && aspectValue !== undefined) {
    positiveNumber(aspectValue, "镜片输出比例");
    return { width: aspectValue, height: 1, aspect: aspectValue };
  }
  const width = positiveNumber(widthValue, "镜片输出宽度", MAX_IMAGE_DIMENSION);
  const height = positiveNumber(heightValue, "镜片输出高度", MAX_IMAGE_DIMENSION);
  const aspect = width / height;
  if (!isFiniteNumber(aspect) || aspect <= 0) throw new RangeError("镜片输出比例无效");
  if (aspectValue !== undefined) {
    positiveNumber(aspectValue, "镜片输出比例");
  }
  return { width, height, aspect };
}

function strictMagnification(value) {
  const magnitude = value === undefined ? DEFAULT_MAGNIFICATION : value;
  requiredFiniteNumber(magnitude, "放大倍率");
  if (magnitude < MIN_MAGNIFICATION || magnitude > MAX_MAGNIFICATION) {
    throw new RangeError("放大倍率超出范围");
  }
  return magnitude;
}

function strictCoordinate(value, label) {
  const coordinate = value === undefined ? 0.5 : value;
  requiredFiniteNumber(coordinate, label);
  return clamp(coordinate, 0, 1);
}

function parseCropArguments(first, second, outputWidth, outputHeight, magnification, u, v) {
  let target = first;
  let reference = second;
  let images;
  let config = null;
  let width = outputWidth;
  let height = outputHeight;
  let magnitude = magnification;
  let normalizedU = u;
  let normalizedV = v;

  const firstDescriptors = dataDescriptors(first);
  const isConfig = firstDescriptors && (
    Object.prototype.hasOwnProperty.call(firstDescriptors, "image")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "targetImage")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "target")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "reference")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "referenceImage")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "images")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "outputWidth")
    || Object.prototype.hasOwnProperty.call(firstDescriptors, "lensWidth")
  );
  if (isConfig) {
    config = firstDescriptors;
    const targetField = cropField(config, ["targetImage", "target", "image"]);
    target = targetField.found ? targetField.value : undefined;
    const referenceField = cropField(config, ["referenceImage", "reference"]);
    reference = referenceField.found ? referenceField.value : undefined;
    const imagesField = cropField(config, ["images"]);
    images = imagesField.found ? imagesField.value : undefined;
    const widthField = cropField(config, ["outputWidth", "lensWidth", "destinationWidth", "cssWidth"]);
    const heightField = cropField(config, ["outputHeight", "lensHeight", "destinationHeight", "cssHeight"]);
    width = widthField.found ? widthField.value : undefined;
    height = heightField.found ? heightField.value : undefined;
    const magnitudeField = cropField(config, ["magnification", "zoom"]);
    magnitude = magnitudeField.found ? magnitudeField.value : undefined;
    const uField = cropField(config, ["u"]);
    const vField = cropField(config, ["v"]);
    normalizedU = uField.found ? uField.value : undefined;
    normalizedV = vField.found ? vField.value : undefined;
  }
  return {
    target,
    reference,
    images,
    config,
    width,
    height,
    magnitude,
    normalizedU,
    normalizedV,
  };
}

function previousFiniteNumber(value) {
  if (!isFiniteNumber(value) || value <= 0) return value;
  const step = Math.max(Number.MIN_VALUE, Math.abs(value) * Number.EPSILON);
  const previous = value - step;
  return previous < value ? previous : value - Number.MIN_VALUE;
}

function safeCropCoordinate(ideal, maximum, extent, bound) {
  let coordinate = clamp(ideal, 0, maximum);
  if (coordinate + extent <= bound) return coordinate;
  coordinate = clamp(bound - extent, 0, maximum);
  // 浮点加法在恰好贴边时可能向上舍入；退一个可表示的安全步长。
  for (let attempt = 0; attempt < 4 && coordinate + extent > bound; attempt += 1) {
    const previous = previousFiniteNumber(coordinate);
    if (previous === coordinate || previous < 0) break;
    coordinate = previous;
  }
  return coordinate;
}

/**
 * 计算同步镜片的源取样矩形。返回值可直接作为 drawImage 的四个源参数。
 * 不可读目标或没有可读参考图时返回 null；数值配置错误会抛出明确异常。
 */
export function calculateSynchronizedCrop(
  first,
  second,
  outputWidth,
  outputHeight,
  magnification,
  u,
  v,
) {
  const parsed = parseCropArguments(
    first,
    second,
    outputWidth,
    outputHeight,
    magnification,
    u,
    v,
  );
  const target = parsed.target === undefined
    ? null
    : normalizeCropImage(parsed.target, "目标图片");
  if (!target) throw new TypeError("缺少目标图片");
  if (!target.readable) return null;

  let reference;
  if (parsed.reference !== undefined) {
    reference = normalizeCropImage(parsed.reference, "参考图片");
    if (!reference.readable) {
      if (!Array.isArray(parsed.images)) return null;
      const fallback = selectReferenceImage(parsed.images);
      if (!fallback.available) return null;
      reference = fallback.image;
    }
  } else {
    if (!Array.isArray(parsed.images)) throw new TypeError("缺少参考图片或图片列表");
    const selected = selectReferenceImage(parsed.images);
    if (!selected.available) return null;
    reference = selected.image;
  }

  const output = parseOutputShape(parsed.config, parsed.width, parsed.height);
  const magnitude = strictMagnification(parsed.magnitude);
  const normalizedU = strictCoordinate(parsed.normalizedU, "横向归一化坐标");
  const normalizedV = strictCoordinate(parsed.normalizedV, "纵向归一化坐标");

  const theoreticalHeight = (REFERENCE_PIXEL_HEIGHT / magnitude) * (target.height / reference.height);
  const theoreticalWidth = theoreticalHeight * output.aspect;
  if (
    !isFiniteNumber(theoreticalWidth)
    || !isFiniteNumber(theoreticalHeight)
    || theoreticalWidth <= 0
    || theoreticalHeight <= 0
  ) {
    throw new RangeError("取样尺寸超出安全范围");
  }

  let fitScale = Math.min(
    1,
    target.width / theoreticalWidth,
    target.height / theoreticalHeight,
  );
  if (!isFiniteNumber(fitScale) || fitScale <= 0) throw new RangeError("取样缩放比例无效");
  let sourceWidth = theoreticalWidth * fitScale;
  let sourceHeight = theoreticalHeight * fitScale;

  // 再做一次边界收敛，消除浮点误差造成的极小越界，同时保持等比缩小。
  const boundScale = Math.min(1, target.width / sourceWidth, target.height / sourceHeight);
  if (!isFiniteNumber(boundScale) || boundScale <= 0) throw new RangeError("取样边界无效");
  if (boundScale < 1) {
    sourceWidth *= boundScale;
    sourceHeight *= boundScale;
  }
  if (
    ![sourceWidth, sourceHeight].every((value) => isFiniteNumber(value) && value > 0)
    || sourceWidth > target.width
    || sourceHeight > target.height
  ) {
    throw new RangeError("取样矩形尺寸无效");
  }

  const maximumX = Math.max(0, target.width - sourceWidth);
  const maximumY = Math.max(0, target.height - sourceHeight);
  const idealX = normalizedU * target.width - sourceWidth / 2;
  const idealY = normalizedV * target.height - sourceHeight / 2;
  const x = safeCropCoordinate(idealX, maximumX, sourceWidth, target.width);
  const y = safeCropCoordinate(idealY, maximumY, sourceHeight, target.height);
  if (
    ![x, y].every(isFiniteNumber)
    || x < 0
    || y < 0
    || x + sourceWidth > target.width
    || y + sourceHeight > target.height
  ) {
    throw new RangeError("取样坐标越界");
  }
  return freezeResult({ x, y, sourceWidth, sourceHeight });
}

export const getSynchronizedCrop = calculateSynchronizedCrop;
export const calculateLoupeCrop = calculateSynchronizedCrop;
export const calculateLoupeSourceRect = calculateSynchronizedCrop;
export const calculateCropSample = calculateSynchronizedCrop;
export const computeCropSample = calculateSynchronizedCrop;

function parseMagnificationArguments(first, second, optionsValue) {
  let current = first;
  let delta = second;
  let options = optionsValue;
  const descriptors = dataDescriptors(first);
  if (descriptors && second === undefined) {
    current = ownField(descriptors, ["magnification", "zoom"]).value;
    delta = ownField(descriptors, ["delta", "deltaY", "wheelDelta"]).value;
    options = first;
  }
  return { current, delta, options };
}

/**
 * 按 demo 的指数规则处理一次滚轮变化。delta 为标准滚轮增量，负值放大。
 * deltaMode=1 使用行高 16，deltaMode=2 使用 pageSize（默认 800）。
 */
export function updateMagnification(first, second, optionsValue = undefined) {
  const parsed = parseMagnificationArguments(first, second, optionsValue);
  const current = strictMagnification(
    parsed.current === undefined ? DEFAULT_MAGNIFICATION : parsed.current,
  );
  requiredFiniteNumber(parsed.delta, "滚轮增量");

  let deltaMode = 0;
  let pageSize = 800;
  if (parsed.options !== undefined) {
    const descriptors = requiredDataDescriptors(parsed.options, "滚轮选项");
    const modeField = ownField(descriptors, ["deltaMode", "mode"]);
    const pageField = ownField(descriptors, ["pageSize", "pageExtent"]);
    if (modeField.found) {
      if (!Number.isInteger(modeField.value) || ![0, 1, 2].includes(modeField.value)) {
        throw new TypeError("滚轮模式无效");
      }
      deltaMode = modeField.value;
    }
    if (pageField.found) pageSize = positiveNumber(pageField.value, "滚轮页尺寸", MAX_IMAGE_DIMENSION);
  }

  const normalizedDelta = parsed.delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageSize : 1);
  if (!isFiniteNumber(normalizedDelta)) throw new RangeError("滚轮增量超出安全范围");
  const steps = clamp(-normalizedDelta / 100, -3, 3);
  const next = current * Math.pow(MAGNIFICATION_STEP_BASE, steps);
  if (!isFiniteNumber(next)) throw new RangeError("放大倍率计算失败");
  return clamp(next, MIN_MAGNIFICATION, MAX_MAGNIFICATION);
}

export const applyWheelMagnification = updateMagnification;
export const nextMagnification = updateMagnification;
export const updateLoupeMagnification = updateMagnification;

/** 稳定的倍率标签，最高倍率严格显示为 1:1。 */
export function formatMagnification(value = DEFAULT_MAGNIFICATION) {
  const magnitude = strictMagnification(value);
  if (magnitude >= MAX_MAGNIFICATION - LABEL_MAX_EPSILON) return "1:1";
  return `${magnitude.toFixed(2)}x`;
}

export const magnificationLabel = formatMagnification;
export const formatZoomLabel = formatMagnification;
