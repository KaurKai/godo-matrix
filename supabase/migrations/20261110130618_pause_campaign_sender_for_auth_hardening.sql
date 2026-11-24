select cron.alter_job(jobid, active := false) from cron.job where jobname='godo-campaign-send';
