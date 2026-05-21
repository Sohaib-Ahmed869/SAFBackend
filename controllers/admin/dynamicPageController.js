const DynamicPage = require("../../models/dynamicPage");
const { deleteS3Object } = require("../../config/s3");

// Safely parse a JSON string coming from multipart/form-data fields.
const parseJSON = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const toBool = (value) => value === true || value === "true";

const normalizeNavPlacement = (navPlacement = {}) => ({
  type: ["topLevel", "dropdown", "none"].includes(navPlacement.type)
    ? navPlacement.type
    : "none",
  dropdownParent: navPlacement.dropdownParent || "",
  label: navPlacement.label || "",
});

const normalizeCta = (cta = {}) => ({
  label: cta.label || "",
  url: cta.url || "",
  openInNewTab: Boolean(cta.openInNewTab),
});

// Merge the JSON section payload with any newly-uploaded section images.
// Uploaded files use field names section_image_0, section_image_1, ...
const buildSections = (sectionsPayload, files) => {
  const list = Array.isArray(sectionsPayload) ? sectionsPayload : [];
  return list.map((section, index) => {
    const matchedFile = (files || []).find(
      (file) => file.fieldname === `section_image_${index}`
    );
    return {
      heading: section.heading || "",
      text: section.text || "",
      imageUrl: matchedFile ? matchedFile.location : section.imageUrl || "",
      imagePath: matchedFile ? matchedFile.key : section.imagePath || "",
      imagePosition: section.imagePosition === "right" ? "right" : "left",
    };
  });
};

// GET /api/admin/pages
exports.listPages = async (_req, res) => {
  try {
    const pages = await DynamicPage.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: pages });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch pages",
      error: error.message,
    });
  }
};

// GET /api/admin/pages/:id
exports.getPage = async (req, res) => {
  try {
    const page = await DynamicPage.findById(req.params.id).lean();
    if (!page) {
      return res
        .status(404)
        .json({ success: false, message: "Page not found" });
    }
    return res.json({ success: true, data: page });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch page",
      error: error.message,
    });
  }
};

// POST /api/admin/pages
exports.createPage = async (req, res) => {
  try {
    const { title, slug, header, description, showFrom, showUntil, isActive } =
      req.body;

    if (!title || !slug || !header) {
      return res.status(400).json({
        success: false,
        message: "Title, slug and header are required",
      });
    }

    const normalizedSlug = String(slug).toLowerCase().trim();
    const existing = await DynamicPage.findOne({ slug: normalizedSlug });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A page with this slug already exists",
      });
    }

    const page = await DynamicPage.create({
      title,
      slug: normalizedSlug,
      header,
      description: description || "",
      cta: normalizeCta(parseJSON(req.body.cta, {})),
      sections: buildSections(parseJSON(req.body.sections, []), req.files),
      navPlacement: normalizeNavPlacement(parseJSON(req.body.navPlacement, {})),
      showFrom: showFrom || null,
      showUntil: showUntil || null,
      isActive: isActive === undefined ? true : toBool(isActive),
    });

    return res
      .status(201)
      .json({ success: true, message: "Page created successfully", data: page });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create page",
      error: error.message,
    });
  }
};

// PUT /api/admin/pages/:id
exports.updatePage = async (req, res) => {
  try {
    const page = await DynamicPage.findById(req.params.id);
    if (!page) {
      return res
        .status(404)
        .json({ success: false, message: "Page not found" });
    }

    const { title, slug, header, description, showFrom, showUntil, isActive } =
      req.body;

    if (slug) {
      const normalizedSlug = String(slug).toLowerCase().trim();
      if (normalizedSlug !== page.slug) {
        const clash = await DynamicPage.findOne({
          slug: normalizedSlug,
          _id: { $ne: page._id },
        });
        if (clash) {
          return res.status(400).json({
            success: false,
            message: "A page with this slug already exists",
          });
        }
        page.slug = normalizedSlug;
      }
    }

    if (title !== undefined) page.title = title;
    if (header !== undefined) page.header = header;
    if (description !== undefined) page.description = description;
    if (req.body.cta !== undefined) {
      page.cta = normalizeCta(parseJSON(req.body.cta, {}));
    }
    if (req.body.navPlacement !== undefined) {
      page.navPlacement = normalizeNavPlacement(
        parseJSON(req.body.navPlacement, {})
      );
    }

    if (req.body.sections !== undefined) {
      const nextSections = buildSections(
        parseJSON(req.body.sections, []),
        req.files
      );
      // Delete any S3 section images that are no longer referenced.
      const keptPaths = nextSections
        .map((section) => section.imagePath)
        .filter(Boolean);
      const removedPaths = (page.sections || [])
        .map((section) => section.imagePath)
        .filter((path) => path && !keptPaths.includes(path));
      for (const key of removedPaths) {
        await deleteS3Object(key);
      }
      page.sections = nextSections;
    }

    if (showFrom !== undefined) page.showFrom = showFrom || null;
    if (showUntil !== undefined) page.showUntil = showUntil || null;
    if (isActive !== undefined) page.isActive = toBool(isActive);

    await page.save();
    return res.json({
      success: true,
      message: "Page updated successfully",
      data: page,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update page",
      error: error.message,
    });
  }
};

// DELETE /api/admin/pages/:id
exports.deletePage = async (req, res) => {
  try {
    const page = await DynamicPage.findById(req.params.id);
    if (!page) {
      return res
        .status(404)
        .json({ success: false, message: "Page not found" });
    }

    for (const section of page.sections || []) {
      if (section.imagePath) {
        await deleteS3Object(section.imagePath);
      }
    }

    await page.deleteOne();
    return res.json({ success: true, message: "Page deleted successfully" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete page",
      error: error.message,
    });
  }
};
