const Imap = require('imap');
const simpleParser = require('mailparser').simpleParser;
const pdf = require('pdf-parse');

function extractInvoiceDetails(pdfBuffer) {
  return pdf(pdfBuffer).then(data => {
    const text = data.text;
    
    // Helper function to extract data using regex
    const extractField = (pattern) => {
      const match = text.match(pattern);
      return match ? match[1].trim() : null;
    };

    // Extract all required fields
    const details = {
      poNumber: extractField(/P\.O\. Number\s*:?\s*([^\n\r]+)/i),
      date: extractField(/Date\s*:?\s*([^\n\r]+)/i),
      poExpiryDate: extractField(/PO expiry date\s*:?\s*([^\n\r]+)/i),
      poDeliveryDate: extractField(/PO delivery date\s*:?\s*([^\n\r]+)/i)
    };

    // Log the extracted details for debugging
    //console.log('Extracted PDF details:', details);

    return details;
  });
}

async function processMessage(msg) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    msg.on('body', (stream, info) => {
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      stream.once('end', async () => {
        const fullMessage = Buffer.concat(chunks);
        try {
          const parsed = await simpleParser(fullMessage);
          //console.log('Parsed email subject:', parsed.subject);
          //console.log('Number of attachments:', parsed.attachments.length);

          const invoices = [];
          for (let attachment of parsed.attachments) {
            //console.log('Processing attachment:', attachment.filename);
            //console.log('Attachment content type:', attachment.contentType);

            if (attachment.contentType === 'application/pdf') {
              try {
                const invoiceDetails = await extractInvoiceDetails(attachment.content);
                if (invoiceDetails.poNumber) {
                  //console.log('Found invoice details:', invoiceDetails);
                  invoices.push({
                    subject: parsed.subject,
                    filename: attachment.filename,
                    ...invoiceDetails
                  });
                } else {
                  //console.log('No invoice ID found in this PDF');
                }
              } catch (error) {
                console.error('Error processing PDF:', error);
              }
            } else {
              //console.log('Attachment is not a PDF, skipping');
            }
          }
          resolve(invoices);
        } catch (error) {
          reject(error);
        }
      });
    });

    msg.once('error', reject);
    msg.once('end', () => console.log('Finished processing message'));
  });
}

function extractInvoices() {
  return new Promise((resolve, reject) => {
    const imapConfig = {
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASSWORD,
      host: 'imap.hostinger.com',
      port: 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: false
      }
    };

    const imap = new Imap(imapConfig);
    const allInvoices = [];

    function openInbox(cb) {
      imap.openBox('INBOX', false, cb);
    }

    imap.once('ready', () => {
      openInbox(async (err, box) => {
        if (err) {
          console.error('Error opening inbox:', err);
          imap.end();
          return reject(err);
        }

        //console.log('Inbox opened successfully');

        try {
          const results = await new Promise((resolve, reject) => {
            imap.search(['ALL', ['SINCE', new Date().toISOString().split('T')[0]]], (err, results) => {
              if (err) reject(err);
              else resolve(results);
            });
          });

          //console.log(`Found ${results.length} messages`);

          if (results.length === 0) {
            //console.log('No messages found, returning empty array');
            imap.end();
            return resolve([]);
          }

          const f = imap.fetch(results, { bodies: '', markSeen: false });
          const messagePromises = [];

          f.on('message', (msg) => {
            messagePromises.push(
              processMessage(msg)
                .then(invoices => {
                  allInvoices.push(...invoices);
                })
                .catch(error => {
                  console.error('Error processing message:', error);
                })
            );
          });

          f.once('error', (err) => {
            console.error('Fetch error:', err);
            imap.end();
            reject(err);
          });

          f.once('end', async () => {
            try {
              await Promise.all(messagePromises);
              //console.log('Finished processing all messages');
              //console.log('Total invoices found:', allInvoices.length);
              imap.end();
              resolve(allInvoices);
            } catch (error) {
              console.error('Error waiting for messages to process:', error);
              imap.end();
              reject(error);
            }
          });
        } catch (error) {
          console.error('Error in IMAP operations:', error);
          imap.end();
          reject(error);
        }
      });
    });

    imap.once('error', (err) => {
      console.error('IMAP connection error:', err);
      reject(err);
    });

    imap.once('end', () => {
      console.log('IMAP connection ended');
    });

    imap.connect();
  });
}

module.exports = { extractInvoices };