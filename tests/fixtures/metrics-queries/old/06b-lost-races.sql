-- lost races, and reclaimed leases, per device
SELECT device,
  count(*) FILTER (WHERE state = 'claim_lost') AS claim_lost,
  count(*) FILTER (WHERE state = 'reclaimed')  AS reclaimed
FROM factory.events
GROUP BY device;
