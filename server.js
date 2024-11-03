const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

// Middleware
app.use(cors());
// Middleware with increased payload limit
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Successfully connected to database');
    connection.release();
});

// Create necessary tables without ending the pool
async function initializeTables() {
    try {
        // Main orders table
        await pool.promise().query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                reference_code VARCHAR(50) UNIQUE,
                ee_invoice_no VARCHAR(50),
                awb_no VARCHAR(50),
                order_status VARCHAR(50),
                shipping_status VARCHAR(50),
                order_date DATETIME,
                courier VARCHAR(100),
                shipping_customer_name VARCHAR(255),
                shipping_address TEXT,
                shipping_city VARCHAR(100),
                shipping_state VARCHAR(100),
                shipping_zip_code VARCHAR(20),
                buyer_gst_num VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_order (reference_code, ee_invoice_no)
            )
        `);

        // Sub-orders table
        await pool.promise().query(`
            CREATE TABLE IF NOT EXISTS sub_orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                order_id INT,
                suborder_no VARCHAR(50) UNIQUE,
                sku VARCHAR(50),
                product_name TEXT,
                quantity INT,
                selling_price DECIMAL(10, 2),
                tax_amount DECIMAL(10, 2),
                total_amount DECIMAL(10, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders(id),
                UNIQUE KEY unique_suborder (suborder_no)
            )
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing tables:', error);
    }
}
// Initialize tables when server starts
initializeTables();

// Test route
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to your Express API!' });
});


app.post('/api/upload-excel', async (req, res) => {
    const data = req.body;

    const connection = await pool.promise().getConnection();

    // Counters for tracking results
    let newOrdersCount = 0;
    let newSubOrdersCount = 0;
    let duplicateSubOrdersCount = 0;

    try {
        await connection.beginTransaction();

        const processedOrders = new Map();

        // Group rows by `Reference Code`
        for (const row of data) {
            const referenceCode = row['Reference Code'];
            const subOrderNo = row['Suborder No'];

            if (!processedOrders.has(referenceCode)) {
                processedOrders.set(referenceCode, {
                    mainOrder: row,
                    subOrders: []
                });
            }
            processedOrders.get(referenceCode).subOrders.push(row);
        }

        // Process and insert each main order
        for (const [referenceCode, orderData] of processedOrders) {
            const [existingOrders] = await connection.query(
                'SELECT id FROM orders WHERE reference_code = ? AND ee_invoice_no = ?',
                [referenceCode, orderData.mainOrder['EE Invoice No']]
            );

            let orderId;
            if (existingOrders.length === 0) {
                // Insert main order and increment new orders counter
                const [orderResult] = await connection.query(`
                    INSERT INTO orders (
                        reference_code, ee_invoice_no, awb_no, order_status,
                        shipping_status, order_date, courier, shipping_customer_name,
                        shipping_address, shipping_city, shipping_state, shipping_zip_code,
                        buyer_gst_num
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    referenceCode,
                    orderData.mainOrder['EE Invoice No'],
                    orderData.mainOrder['AWB No'],
                    orderData.mainOrder['Order Status'],
                    orderData.mainOrder['Shipping Status'],
                    new Date(orderData.mainOrder['Order Date']),
                    orderData.mainOrder['Courier'],
                    orderData.mainOrder['Shipping Customer Name'],
                    orderData.mainOrder['Shipping Address Line 1'],
                    orderData.mainOrder['Shipping City'],
                    orderData.mainOrder['Shipping State'],
                    orderData.mainOrder['Shipping Zip Code'],
                    orderData.mainOrder['Buyer GST Num']
                ]);
                
                orderId = orderResult.insertId;
                newOrdersCount++; // Increment new orders counter
            } else {
                orderId = existingOrders[0].id;
            }

            // Insert sub-orders and track duplicates
            for (const subOrder of orderData.subOrders) {
                const [existingSubOrders] = await connection.query(
                    'SELECT id FROM sub_orders WHERE suborder_no = ?',
                    [subOrder['Suborder No']]
                );

                if (existingSubOrders.length === 0) {
                    await connection.query(`
                        INSERT INTO sub_orders (
                            order_id, suborder_no, sku, product_name,
                            quantity, selling_price, tax_amount, total_amount
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        orderId,
                        subOrder['Suborder No'],
                        subOrder['SKU'],
                        subOrder['Product Name'],
                        subOrder['Item Quantity'],
                        subOrder['Selling Price'],
                        subOrder['Tax'],
                        subOrder['Order Invoice Amount']
                    ]);
                    newSubOrdersCount++; // Increment new suborders counter
                } else {
                    duplicateSubOrdersCount++; // Increment duplicates counter
                }
            }
        }

        await connection.commit();
        res.status(200).json({
            message: 'Data uploaded successfully',
            newOrdersCount,
            newSubOrdersCount,
            duplicateSubOrdersCount
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error uploading data:', error);
        res.status(500).json({ message: 'Error uploading data', error: error.message });
    } finally {
        connection.release();
    }
});



// Get orders with sub-orders
app.get('/api/orders', async (req, res) => {
    try {
        const [orders] = await pool.promise().query(`
            SELECT o.*, 
                   JSON_ARRAYAGG(
                       JSON_OBJECT(
                           'suborder_no', s.suborder_no,
                           'sku', s.sku,
                           'product_name', s.product_name,
                           'quantity', s.quantity,
                           'selling_price', s.selling_price,
                           'tax_amount', s.tax_amount,
                           'total_amount', s.total_amount
                       )
                   ) as sub_orders
            FROM orders o 
            LEFT JOIN sub_orders s ON o.id = s.order_id
            GROUP BY o.id
            ORDER BY o.order_date DESC
        `);

        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

app.get('/api/tracking/:awbNo', async (req, res) => {
    const awbNo = req.params.awbNo; // Remove the first character
    try {
      const { default: fetch } = await import('node-fetch');
      const response = await fetch(`https://www.xpressbees.com/api/tracking/${awbNo}`, {
        headers: {
          'Referer': `https://www.xpressbees.com/shipment/tracking?awbNo=${awbNo}`
        }
      });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch tracking data' });
    }
  });

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke!' });
});

// Gracefully close the pool when exiting the app
process.on('SIGINT', async () => {
    console.log('Closing database pool...');
    await pool.end();
    process.exit(0);
});

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});