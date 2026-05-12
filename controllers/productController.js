const Product = require('../models/product');
const { s3Client, deleteS3Object } = require('../config/s3');

const FEATURED_LIMIT = 4;

const toBool = (v) => v === 'true' || v === true;

// Throws a 400-style error if turning this product into a featured one
// would exceed the FEATURED_LIMIT. `selfId` is excluded from the count.
const assertFeaturedCapacity = async (selfId = null) => {
    const filter = { featured: true, isActive: true };
    if (selfId) filter._id = { $ne: selfId };
    const count = await Product.countDocuments(filter);
    if (count >= FEATURED_LIMIT) {
        const err = new Error(
            `You can only feature up to ${FEATURED_LIMIT} products. Unfeature an existing one first.`
        );
        err.statusCode = 400;
        throw err;
    }
};

// @desc    Create a new product
// @route   POST /api/products
// @access  Private/Admin
exports.createProduct = async (req, res) => {
    try {
        const { title, description, price, category, zakatEligible, sadaqahEligible, featured, featuredOrder } = req.body;

        // Validate required fields
        if (!title || !description || !price || !category) {
            return res.status(400).json({ message: 'Please provide all required fields' });
        }

        // Check if image was uploaded
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Product image is required'
            });
        }

        const isFeatured = toBool(featured);
        if (isFeatured) {
            await assertFeaturedCapacity();
        }

        // Get the S3 file URL from the uploaded file
        const imageUrl = req.file.location;
        const imagePath = req.file.key; // The S3 key/path

        // Create new product
        const product = new Product({
            title,
            description,
            price,
            category,
            image: imageUrl,  // Store full S3 URL
            imagePath: imagePath,  // Store S3 key for future reference
            zakatEligible: toBool(zakatEligible),
            sadaqahEligible: toBool(sadaqahEligible),
            featured: isFeatured,
            featuredOrder: Number.isFinite(Number(featuredOrder)) ? Number(featuredOrder) : 0
        });

        const savedProduct = await product.save();

        res.status(201).json({
            success: true,
            message: 'Product created successfully',
            product: savedProduct
        });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all products
// @route   GET /api/products
// @access  Public
exports.getProducts = async (req, res) => {
    try {
        const products = await Product.find({ isActive: true });
        res.json({ success: true, products });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        res.json({ success: true, product });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private/Admin
exports.updateProduct = async (req, res) => {
    try {
        const { title, description, price, category, zakatEligible, sadaqahEligible, featured, featuredOrder } = req.body;
        const updateData = {
            title,
            description,
            price,
            category,
            zakatEligible: toBool(zakatEligible),
            sadaqahEligible: toBool(sadaqahEligible)
        };

        // Find the existing product
        const existingProduct = await Product.findById(req.params.id);
        if (!existingProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Featured flag — only enforce cap when transitioning from
        // not-featured to featured. Order can change freely.
        if (typeof featured !== 'undefined') {
            const willBeFeatured = toBool(featured);
            if (willBeFeatured && !existingProduct.featured) {
                await assertFeaturedCapacity(existingProduct._id);
            }
            updateData.featured = willBeFeatured;
        }
        if (typeof featuredOrder !== 'undefined') {
            const n = Number(featuredOrder);
            updateData.featuredOrder = Number.isFinite(n) ? n : 0;
        }

        // If a new image is uploaded
        if (req.file) {
            // Delete the old image from S3
            if (existingProduct.imagePath) {
                try {
                    await deleteS3Object(existingProduct.imagePath);
                } catch (s3Error) {
                    console.error('Error deleting old image from S3:', s3Error);
                    // Continue with the update even if deletion fails
                }
            }
            
            // Update with new image details
            updateData.image = req.file.location;
            updateData.imagePath = req.file.key;
        }

        const updatedProduct = await Product.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true, runValidators: true }
        );

        res.json({
            success: true,
            message: 'Product updated successfully',
            product: updatedProduct
        });
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Server error',
            error: error.message
        });
    }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private/Admin
exports.deleteProduct = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Delete the image from S3
        if (product.imagePath) {
            try {
                await deleteS3Object(product.imagePath);
            } catch (s3Error) {
                console.error('Error deleting image from S3:', s3Error);
                // Continue with the deletion even if image deletion fails
            }
        }

        // Remove the product from the database
        await Product.findByIdAndDelete(req.params.id);
        
        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get featured products for home page (capped at FEATURED_LIMIT)
// @route   GET /api/products/featured
// @access  Public
exports.getFeaturedProducts = async (req, res) => {
    try {
        const products = await Product.find({ featured: true, isActive: true })
            .sort({ featuredOrder: 1, createdAt: -1 })
            .limit(FEATURED_LIMIT);
        res.json({ success: true, products });
    } catch (error) {
        console.error('Error fetching featured products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all categories
// @route   GET /api/products/categories
// @access  Public
exports.getCategories = async (req, res) => {
    try {
        const categories = await Product.distinct('category');
        res.json({ success: true, categories });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};
