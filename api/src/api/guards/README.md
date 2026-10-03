# Guard slots
Authentication (session/API key), audience, tenant, scopes, role and object access guards
belong here. Guards invoke shared authorization services; route grouping is not access control.
No guards are implemented or registered. Business endpoints must add them before becoming callable.
