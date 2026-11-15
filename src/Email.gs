/**
 * Email.gs — owner notification for new orders.
 */

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notificationRecipient_() {
  return getProp_(PROPS.NOTIFICATION_EMAIL) || Session.getEffectiveUser().getEmail();
}

/** Returns { subject, body, htmlBody } for an order saved by processOrder_. */
function buildOrderEmail_(order) {
  var c = order.customer;
  var subject = 'New T-Shirt Order #' + order.orderId;

  var text = [
    'Order Reference: #' + order.orderId,
    '',
    'Customer Details:',
    '- Name: ' + c.name,
    '- Phone: ' + c.phone,
    '- Email: ' + c.email,
    '- Shipping Address:',
    c.address.split('\n').map(function (l) { return '    ' + l; }).join('\n'),
    '',
    'Order Summary:'
  ];
  order.items.forEach(function (i) {
    text.push('- ' + i.productId + ' | ' + i.name + ' | Color: ' + i.color + ' | Size: ' + i.size +
      ' | Qty: ' + i.quantity + ' | ' + formatMoney_(i.unitPrice) + ' each = ' + formatMoney_(i.lineTotal));
  });
  text.push('', 'Total Price: ' + formatMoney_(order.total) + ' (products only, delivery not included)',
    '', 'Order Status: ' + CONFIG.DEFAULT_ORDER_STATUS, '',
    'Reply to this email to contact the customer.');

  var cell = 'padding:8px 10px;border-bottom:1px solid #e5e5e5;text-align:left;';
  var rows = order.items.map(function (i) {
    return '<tr><td style="' + cell + '">' + escapeHtml_(i.productId) + '</td>' +
      '<td style="' + cell + '">' + escapeHtml_(i.name) + '</td>' +
      '<td style="' + cell + '">' + escapeHtml_(i.color) + '</td>' +
      '<td style="' + cell + '">' + escapeHtml_(i.size) + '</td>' +
      '<td style="' + cell + 'text-align:right;">' + i.quantity + '</td>' +
      '<td style="' + cell + 'text-align:right;">' + escapeHtml_(formatMoney_(i.unitPrice)) + '</td>' +
      '<td style="' + cell + 'text-align:right;">' + escapeHtml_(formatMoney_(i.lineTotal)) + '</td></tr>';
  }).join('');

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#242424;max-width:640px;">' +
    '<h2 style="margin:0 0 4px;">Order Reference: #' + escapeHtml_(order.orderId) + '</h2>' +
    '<p style="margin:0 0 20px;color:#777;">Order Status: <strong>' + escapeHtml_(CONFIG.DEFAULT_ORDER_STATUS) + '</strong></p>' +
    '<h3 style="margin:0 0 8px;">Customer Details</h3>' +
    '<ul style="margin:0 0 20px;padding-left:18px;line-height:1.6;">' +
    '<li><strong>Name:</strong> ' + escapeHtml_(c.name) + '</li>' +
    '<li><strong>Phone:</strong> ' + escapeHtml_(c.phone) + '</li>' +
    '<li><strong>Email:</strong> ' + escapeHtml_(c.email) + '</li>' +
    '<li><strong>Shipping Address:</strong><br>' + escapeHtml_(c.address).replace(/\n/g, '<br>') + '</li>' +
    '</ul>' +
    '<h3 style="margin:0 0 8px;">Order Summary</h3>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    '<thead><tr>' +
    '<th style="' + cell + '">ID</th><th style="' + cell + '">Product</th>' +
    '<th style="' + cell + '">Color</th><th style="' + cell + '">Size</th>' +
    '<th style="' + cell + 'text-align:right;">Qty</th><th style="' + cell + 'text-align:right;">Unit price</th>' +
    '<th style="' + cell + 'text-align:right;">Line total</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '<tfoot><tr><td colspan="6" style="' + cell + 'text-align:right;font-weight:bold;">Total Price</td>' +
    '<td style="' + cell + 'text-align:right;font-weight:bold;">' + escapeHtml_(formatMoney_(order.total)) + '</td></tr></tfoot>' +
    '</table>' +
    '<p style="color:#777;font-size:13px;">Products only — delivery is not included. Reply to this email to contact the customer.</p>' +
    '</div>';

  return { subject: subject, body: text.join('\n'), htmlBody: html };
}

/**
 * Sends the owner notification. Never throws. On failure it logs the error and
 * adds a note to the order's "Order ID" cell, so the Orders columns stay unchanged.
 */
function notifyOwnerSafely_(order, sheet) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Daily email quota exhausted');
    var email = buildOrderEmail_(order);
    MailApp.sendEmail({
      to: notificationRecipient_(),
      subject: email.subject,
      body: email.body,
      htmlBody: email.htmlBody,
      replyTo: order.customer.email,
      name: CONFIG.STORE_NAME + ' Orders'
    });
    return true;
  } catch (err) {
    var message = 'Email notification failed: ' + (err && err.message || err);
    console.error('Order #' + order.orderId + ': ' + message);
    try {
      sheet.getRange(order.row, 2).setNote(message + ' (' + new Date().toISOString() + ')');
    } catch (noteErr) {
      console.error('Could not record the email failure on the sheet: ' + noteErr);
    }
    return false;
  }
}

