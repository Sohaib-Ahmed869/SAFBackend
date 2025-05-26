const Product = require('../models/product');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs-extra');
const { promisify } = require('util');

// Promisify fs methods
const renameAsync = promisify(fs.rename);
const unlinkAsync = promisify(fs.unlink);
const mkdirp = promisify(fs.mkdir);

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../public/uploads/products');
const tempDir = path.join(__dirname, '../public/uploads/temp');

const ensureDirectories = async () => {
  try {
    await fs.ensureDir(uploadDir);
    await fs.ensureDir(tempDir);
  } catch (error) {
    console.error('Error creating upload directories:', error);
    throw new Error('Failed to initialize upload directories');
  }
};

// Initialize directories on startup
ensureDirectories().catch(console.error);

// @desc    Create a new product
// @route   POST /api/products
// @access  Private/Admin
exports.createProduct = async (req, res) => {
    try {
        const { title, description, price, category } = req.body;
        
        // Validate required fields
        if (!title || !description || !price || !category) {
            return res.status(400).json({ message: 'Please provide all required fields' });
        }

        // Handle image upload
        if (!req.file) {
            return res.status(400).json({ 
                success: false,
                message: 'Product image is required' 
            });
        }

        const fileExt = path.extname(req.file.originalname).toLowerCase();
        const fileName = `${uuidv4()}${fileExt}`;
        const uploadPath = path.join(uploadDir, fileName);
        
        try {
            // Move the uploaded file from temp to permanent location
            await renameAsync(req.file.path, uploadPath);
        } catch (error) {
            console.error('Error moving uploaded file:', error);
            // Clean up temp file if it exists
            if (fs.existsSync(req.file.path)) {
                await unlinkAsync(req.file.path).catch(console.error);
            }
            return res.status(500).json({ 
                success: false, 
                message: 'Failed to process image upload' 
            });
        }
        
        // Construct the full URL for the image
        const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
        const imagePath = `/uploads/products/${fileName}`;
        const imageUrl = `${baseUrl}${imagePath}`;

        // Create new product
        const product = new Product({
            title,
            description,
            price,
            category,
            image: imageUrl,  // Store full URL for better client-side usage
            imagePath: imagePath  // Also store the relative path for server-side operations
        });

        const savedProduct = await product.save();
        
        res.status(201).json({ 
            success: true, 
            message: 'Product created successfully',
            product: savedProduct
        });
    } catch (error) {
        console.error('Error creating product:', error);
        
        // Clean up uploaded file if it exists
        if (req.file && req.file.path) {
            try {
                if (fs.existsSync(req.file.path)) {
                    await unlinkAsync(req.file.path).catch(console.error);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up file:', cleanupError);
            }
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Error creating product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
};

// @desc    Get all products
// @route   GET /api/products
// @access  Public
exports.getProducts = async (req, res) => {
    try {
        const { category, search } = req.query;
        let query = { isActive: true };
        
        // Filter by category if provided
        if (category) {
            query.category = category;
        }
        
        // Search functionality
        if (search) {
            query.$text = { $search: search };
        }
        
        let products = await Product.find(query).sort({ createdAt: -1 }).lean();
        
        // Ensure all products have the correct image URL
        const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
        products = products.map(product => ({
            ...product,
            // If image doesn't start with http, prepend the base URL
            image: product.image && !product.image.startsWith('http') 
                ? `${baseUrl}${product.image}` 
                : product.image
        }));
        
        res.status(200).json({ 
            success: true, 
            count: products.length,
            products 
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching products',
            error: error.message 
        });
    }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res) => {
    try {
        const product = await Product.findById(req.params.id).lean();
        
        if (!product) {
            return res.status(404).json({ 
                success: false, 
                message: 'Product not found' 
            });
        }
        
        // Ensure the product has the correct image URL
        const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
        const productWithUrl = {
            ...product,
            // If image doesn't start with http, prepend the base URL
            image: product.image && !product.image.startsWith('http')
                ? `${baseUrl}${product.image}`
                : product.image
        };
        
        res.status(200).json({ 
            success: true, 
            product: productWithUrl
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching product',
            error: error.message 
        });
    }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private/Admin
exports.updateProduct = async (req, res) => {
    try {
        const { title, description, price, category, isActive } = req.body;
        const product = await Product.findById(req.params.id);
        
        if (!product) {
            return res.status(404).json({ 
                success: false, 
                message: 'Product not found' 
            });
        }
        
        // Handle image upload if new image is provided
        if (req.file) {
            // Delete old image if exists
            if (product.image) {
                const oldImagePath = path.join(__dirname, '../public', product.image);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
            
            // Save new image
            const fileExt = path.extname(req.file.originalname);
            const fileName = `${uuidv4()}${fileExt}`;
            const uploadPath = path.join(__dirname, '../public/uploads/products', fileName);
            
            // Ensure the uploads directory exists
            const uploadDir = path.join(__dirname, '../public/uploads/products');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            fs.renameSync(req.file.path, uploadPath);
            product.image = `/uploads/products/${fileName}`;
        }
        
        // Update product fields
        product.title = title || product.title;
        product.description = description || product.description;
        if (price) product.price = price;
        if (category) product.category = category;
        if (typeof isActive !== 'undefined') product.isActive = isActive;
        
        const updatedProduct = await product.save();
        
        // Ensure the product has the correct image URL
        const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
        const productWithUrl = {
            ...updatedProduct.toObject(),
            // If image doesn't start with http, prepend the base URL
            image: updatedProduct.image && !updatedProduct.image.startsWith('http')
                ? `${baseUrl}${updatedProduct.image}`
                : updatedProduct.image
        };
        
        res.status(200).json({ 
            success: true, 
            message: 'Product updated successfully',
            product: productWithUrl
        });
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error updating product',
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
        
        // Delete product image if exists
        if (product.image) {
            const imagePath = path.join(__dirname, '../public', product.image);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        
        await product.remove();
        
        res.status(200).json({ 
            success: true, 
            message: 'Product deleted successfully' 
        });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error deleting product',
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
        res.status(200).json({ 
            success: true, 
            categories 
        });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching categories',
            error: error.message 
        });
    }
};
