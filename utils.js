import _ from 'lodash';

export function time_to_minutes(time)
{
    time = time.split(':');

    return (parseInt(time[0])*60) + parseInt(time[1]);
};

export function is_empty(val)
{
	if (val === null || typeof val == 'undefined')
		return true;

	if (typeof val == 'string')
		return val.trim().length == 0;

	if (typeof val == 'function' || typeof val == 'number' || typeof val == 'boolean')
		return false;

	if (typeof val == 'object')
		return _.isEmpty(val);

	return true;
};