const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { registerCustomerRegistryApi } = require('../../services/customer-registry-http');
const { SettlementConflictError } = require('../../services/customer-settlement');

function request(server, method, path, role, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host:'127.0.0.1', port:server.address().port, method, path, headers:{'content-type':'application/json', ...(role?{'x-role':role}:{})} }, res => {
            const chunks=[];
            res.on('data', x => chunks.push(x));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let responseBody = {};
                try { responseBody = JSON.parse(text || '{}'); } catch { responseBody = { text }; }
                resolve({ status:res.statusCode, body:responseBody });
            });
        }); req.on('error',reject); if(body)req.write(JSON.stringify(body)); req.end();
    });
}
test('customer registry HTTP roles, input boundary, actors, and safe failures', async t => {
    const calls=[];
    const service={
        listCustomers: async options=>{calls.push(['list',options]);return [];}, getCustomer:async()=>null,
        createCustomerRecord:async input=>{calls.push(['create',input]);if(input.display_name==='conflict')throw new SettlementConflictError();if(input.display_name==='boom')throw new Error('secret sms 0712345678');return {idempotent:false,customer:{id:'c1'}};},
        updateCustomerRecord:async input=>({idempotent:false,customer:input}), deactivateCustomer:async input=>({idempotent:false,customer:input})
    };
    const app=express(); app.use(express.json()); app.use((req,res,next)=>{const role=req.headers['x-role'];req.session=role?{userId:'session-user',userRole:role}:{};next();});
    const requireRole=(...roles)=>(req,res,next)=>!req.session.userId?res.status(401).json({error:'Unauthorized'}):!roles.includes(req.session.userRole)?res.status(403).json({error:'Forbidden'}):next();
    registerCustomerRegistryApi(app,{customerService:service,requireRole});
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}); t.after(()=>server.close());
    assert.equal((await request(server,'GET','/api/customers')).status,401);
    assert.equal((await request(server,'GET','/api/customers','viewer')).status,200);
    assert.equal((await request(server,'POST','/api/customers','viewer',{display_name:'A',idempotency_key:'k'})).status,403);
    // Caller-supplied actor identifiers are refused; the server derives actor
    // provenance exclusively from the authenticated session.
    assert.equal((await request(server,'POST','/api/customers','farmer',{display_name:'A',idempotency_key:'k',created_by_user_id:'evil'})).status,400);
    assert.equal((await request(server,'POST','/api/customers','farmer',{display_name:'A',idempotency_key:'k'})).status,201);
    assert.equal(calls.find(x=>x[0]==='create')[1].created_by_user_id,'session-user');
    assert.equal((await request(server,'POST','/api/customers','admin',{display_name:'Admin Customer',idempotency_key:'admin-k'})).status,201);
    assert.equal((await request(server,'POST','/api/customers','admin',{display_name:'A',idempotency_key:'k',unknown:true})).status,400);
    assert.equal((await request(server,'GET','/api/customers?include_inactive=maybe','viewer')).status,400);
    assert.equal((await request(server,'POST','/api/customers','admin',{display_name:'conflict',idempotency_key:'k2'})).status,409);
    const failure=await request(server,'POST','/api/customers','admin',{display_name:'boom',idempotency_key:'k3'}); assert.deepEqual([failure.status,failure.body],[500,{error:'Customer service unavailable'}]);
    assert.doesNotMatch(JSON.stringify(failure.body),/secret|0712345678/i);
    assert.equal((await request(server,'DELETE','/api/customers/c1','admin')).status,404);
});
