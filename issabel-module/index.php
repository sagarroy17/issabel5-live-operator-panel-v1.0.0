<?php
function _moduleContent(&$smarty, $module_name)
{
    return '
    <div style="width: 100%; height: calc(100vh - 75px); margin: 0; padding: 0; overflow: hidden; border-radius: 8px; background: #0b1120;">
        <iframe src="/op-panel/" style="width: 100%; height: 100%; border: none;"></iframe>
    </div>';
}
?>
