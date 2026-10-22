export async function auditable(connection, {
  organizationId,
  propertyId = null,
  actorId,
  action,
  entity,
  entityId = null,
  before = null,
  after = null,
  ip = null,
}) {
  await connection.execute(
    `INSERT INTO audit_log
      (organization_id, property_id, actor_id, action, entity, entity_id, \`before\`, \`after\`, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId,
      propertyId,
      actorId,
      action,
      entity,
      entityId === null ? null : String(entityId),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      ip,
    ],
  );
}

export async function inAuditedTransaction(db, req, audit, operation) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await auditable(connection, {
      organizationId: req.auth.orgId,
      propertyId: req.propertyId ?? req.auth.activePropertyId,
      actorId: req.auth.sub,
      ip: req.ip,
      ...audit(result),
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
