const { SettlementConflictError, SettlementNotFoundError } = require('./customer-settlement');

function fail(res, error) {
    if (error instanceof SettlementNotFoundError) return res.status(404).json({ error: 'Customer not found' });
    if (error instanceof SettlementConflictError) return res.status(409).json({ error: 'Customer request conflicts' });
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: 'Invalid customer request' });
    return res.status(500).json({ error: 'Customer service unavailable' });
}
function shape(body, allowed) { return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => allowed.has(key)); }
function registerCustomerRegistryApi(app, { customerService, requireRole }) {
    const read = requireRole('super_admin', 'admin', 'farmer', 'viewer'); const write = requireRole('super_admin', 'admin', 'farmer');
    app.get('/api/customers', read, async (req, res) => { if(req.query.include_inactive!==undefined&&!['true','false'].includes(req.query.include_inactive))return res.status(400).json({error:'Invalid customer request'}); try{return res.json(await customerService.listCustomers({include_inactive:req.query.include_inactive==='true'}));}catch(error){return fail(res,error);} });
    app.get('/api/customers/:id', read, async (req,res)=>{try{const customer=await customerService.getCustomer(req.params.id);return customer?res.json(customer):res.status(404).json({error:'Customer not found'});}catch(error){return fail(res,error);}});
    app.post('/api/customers', write, async (req,res)=>{if(!shape(req.body,new Set(['display_name','payment_terms_days','contact_phone','idempotency_key'])))return res.status(400).json({error:'Invalid customer request'});try{const result=await customerService.createCustomerRecord({...req.body,created_by_user_id:req.session.userId});return res.status(result.idempotent?200:201).json(result);}catch(error){return fail(res,error);}});
    app.patch('/api/customers/:id', write, async (req,res)=>{if(!shape(req.body,new Set(['display_name','payment_terms_days','contact_phone','is_active','idempotency_key'])))return res.status(400).json({error:'Invalid customer request'});try{return res.json(await customerService.updateCustomerRecord({...req.body,id:req.params.id,updated_by_user_id:req.session.userId}));}catch(error){return fail(res,error);}});
    app.post('/api/customers/:id/deactivate', write, async (req,res)=>{if(!shape(req.body,new Set(['idempotency_key'])))return res.status(400).json({error:'Invalid customer request'});try{return res.json(await customerService.deactivateCustomer({...req.body,id:req.params.id,updated_by_user_id:req.session.userId}));}catch(error){return fail(res,error);}});
}
module.exports={registerCustomerRegistryApi};
